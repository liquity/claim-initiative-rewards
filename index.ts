import { subtract, greaterThanOrEqual } from "dnum";
import { createPublicClient, createWalletClient, getContract, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { Address, getAddress } from "viem";
import governanceAbi from "./governance.abi";
import merklInitiativeAbi from "./merklInitiative.abi";

const GOVERNANCE = "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1";
const INITIATIVES = [
  "0xba415afa8fcd65196764b5e08cb4dbf90bee33b4", // CURVE_BOLD_USDC
  "0x0c76eae597afa2aa163a8c845f7e7e870256ac7e", // CURVE_BOLD_LUSD
  "0xdc6f869d2d34e4aee3e89a51f2af6d54f0f7f690", // DEFI_COLLECTIVE
];
const MERKL_INITIATIVES = [
  "0xB42448852A1BFc99d66ed53C65e2B49cF954f615", // UNIV4_BOLD_USDC_MERKL_INITIATIVE
];
const CLAIMABLE = 3; // Initiative status

type InitiativeKind = "generic" | "merkl";

const assertNever = (value: never): never => {
  throw new Error(`Unhandled value: ${value}`);
};

const isValidPk = (k: string): k is `0x${string}` => k.startsWith("0x");
if (!process.env.PRIVATE_KEY || !isValidPk(process.env.PRIVATE_KEY)) {
  throw new Error("The PRIVATE_KEY env variable must be set to a valid private key.");
}

const client = {
  wallet: createWalletClient({
    account: privateKeyToAccount(process.env.PRIVATE_KEY),
    chain: mainnet,
    transport: http(),
  }),
  public: createPublicClient({
    batch: {
      multicall: true,
    },
    chain: mainnet,
    transport: http(),
  }),
};

async function claimForInitiative(initiative: Address, kind: InitiativeKind = "generic") {
  const governance = getContract({
    address: GOVERNANCE,
    abi: governanceAbi,
    client,
  });

  // get current epoch
  const currentEpoch = await governance.read.epoch();

  // get last claim epoch
  const [status, lastEpochClaim, claimableAmount] = await governance.read.getInitiativeState([initiative]);

  console.log();
  console.log(`Current epoch:     ${currentEpoch}`);
  console.log(`Last claim epoch:  ${lastEpochClaim}`);
  console.log(`Initiative status: ${status}`);
  console.log(`Claimable amount:  ${claimableAmount}`);

  // TODO: in case of Merkl initiatives, someone could have claimed directly through Governance,
  // in which case we still need to create the campaign. How to detect this best?
  if (greaterThanOrEqual(lastEpochClaim, subtract(currentEpoch, 1))) {
    console.log(`Already claimed (${initiative})`);
    return;
  }
  if (claimableAmount == 0) {
    console.log(`Nothing to claim (${initiative})`);
    return;
  }
  if (status != CLAIMABLE) {
    console.log(`Not claimable status (${initiative})`);
    return;
  }

  // Claim
  console.log();
  console.log(`Claiming for Initiative at ${initiative}`);
  let txHash;
  switch (kind) {
    case "generic":
      txHash = await governance.write.claimForInitiative([initiative]);
      break;
    case "merkl":
      const merklInitiative = getContract({
        address: initiative,
        abi: merklInitiativeAbi,
        client,
      });
      txHash = await merklInitiative.write.claimForInitiative();
      break;
    default:
      return assertNever(kind);
  }
  console.log("tx hash: ", txHash);

  // Wait for tx to be mined
  // TODO: get current nonce and increment for every tx/initiative
  //await new Promise(f => setTimeout(f, 60000));
  await client.public.waitForTransactionReceipt({ hash: txHash });

  return;
}

async function main() {
  for (const initiative of INITIATIVES) {
    await claimForInitiative(getAddress(initiative));
  }
  // Merkl needs a wrapper, not claimed directly on Governance
  for (const initiative of MERKL_INITIATIVES) {
    await claimForInitiative(getAddress(initiative), "merkl");
  }
}

// init
main();
