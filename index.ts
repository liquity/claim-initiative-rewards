import { subtract, greaterThanOrEqual } from "dnum";
import { createPublicClient, createWalletClient, getContract, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { Address, getAddress } from "viem";
import governanceAbi from "./governance.abi";

const GOVERNANCE = "0x636deb767cd7d0f15ca4ab8ea9a9b26e98b426ac";
const INITIATIVES = [
  "0x4347d2d28a3428ddf1b7cfc7f097b2128a1a0059", // CURVE_BOLD_LUSD
  "0xa76434d58ccc9b8277180a691148a598fd073035", // CURVE_BOLD_USDC
  "0xdc6f869d2d34e4aee3e89a51f2af6d54f0f7f690", // DEFI_COLLECTIVE
];
const CLAIMABLE = 3; // Initiative status

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

async function claimForInitiative(initiative: Address) {
  const contract = getContract({
    address: GOVERNANCE,
    abi: governanceAbi,
    client,
  });

  // get current epoch
  const currentEpoch = await contract.read.epoch();

  // get last claim epoch
  const [status, lastEpochClaim, claimableAmount] = await contract.read.getInitiativeState([initiative]);

  console.log()
  console.log(`Current epoch:     ${currentEpoch}`);
  console.log(`Last claim epoch:  ${lastEpochClaim}`);
  console.log(`Initiative status: ${status}`);
  console.log(`Claimable amount:  ${claimableAmount}`);

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
  console.log()
  console.log(`Claiming for Initiative at ${initiative}`);
  const txHash = await contract.write.claimForInitiative([initiative]);
  console.log('tx hash: ', txHash);

  // Wait for tx to be mined
  // TODO: get current nonce and increment for every tx/initiative
  //await new Promise(f => setTimeout(f, 60000));
  await client.public.waitForTransactionReceipt({ hash: txHash })

  return;
}

async function main() {
  for (const initiative of INITIATIVES) {
    await claimForInitiative(getAddress(initiative));
  }
}

// init
main()
