import { subtract, greaterThanOrEqual } from "dnum";
import { type Address, createPublicClient, createWalletClient, getContract, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import governanceAbi from "./governance.abi";
import merklInitiativeAbi from "./merklInitiative.abi";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5 * 60 * 1000); // 5 minutes

const GOVERNANCE = "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1";

type InitiativeKind = "generic" | "merkl";
type Initiative = { kind: InitiativeKind; address: `0x${string}` };

const INITIATIVES: Initiative[] = [
  { kind: "generic", address: "0xba415afa8fcd65196764b5e08cb4dbf90bee33b4" }, // CURVE_BOLD_USDC
  { kind: "generic", address: "0x0c76eae597afa2aa163a8c845f7e7e870256ac7e" }, // CURVE_BOLD_LUSD
  { kind: "generic", address: "0xdc6f869d2d34e4aee3e89a51f2af6d54f0f7f690" }, // DEFI_COLLECTIVE
  { kind: "merkl", address: "0xB42448852A1BFc99d66ed53C65e2B49cF954f615" }, // UNIV4_BOLD_USDC_MERKL_INITIATIVE
];

const CLAIMABLE = 3; // Initiative status

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
    transport: http(process.env.RPC_URL),
  }),
  public: createPublicClient({
    batch: {
      multicall: true,
    },
    chain: mainnet,
    transport: http(process.env.RPC_URL),
  }),
};

const lastClaimedEpoch = new Map<Address, bigint>(); // in-memory cache, reset on restart

async function claimForInitiative(initiative: Address, kind: InitiativeKind = "generic") {
  const governance = getContract({
    address: GOVERNANCE,
    abi: governanceAbi,
    client,
  });

  // get current epoch
  const currentEpoch = await governance.read.epoch();

  // skip if we already claimed in this epoch during this run
  if (greaterThanOrEqual(lastClaimedEpoch.get(initiative) ?? -1n, currentEpoch - 1n)) {
    console.log(`Already claimed this epoch (${initiative})`);
    return;
  }

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
    lastClaimedEpoch.set(initiative, currentEpoch);
    return;
  }
  if (claimableAmount === 0n) {
    console.log(`Nothing to claim (${initiative})`);
    lastClaimedEpoch.set(initiative, currentEpoch);
    return;
  }
  if (status != CLAIMABLE) {
    console.log(`Not claimable status (${initiative})`);
    lastClaimedEpoch.set(initiative, currentEpoch);
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

  // Wait for tx to be mined
  // TODO: get current nonce and increment for every tx/initiative
  //await new Promise(f => setTimeout(f, 60000));
  console.log("TX hash: ", txHash);
  const receipt = await client.public.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Claim transaction reverted (${txHash})`);

  lastClaimedEpoch.set(initiative, currentEpoch);
}

let running = true;
let shutdownSignalCount = 0;
let triggerWakeUp: (() => void) | undefined;

function shutdown(signal: string) {
  if (++shutdownSignalCount > 1) {
    console.log(`\nReceived ${signal} again, exiting prematurely.`);
    process.exit(1);
  }

  console.log(`\nReceived ${signal}, shutting down after current poll... (send ${signal} again to exit prematurely)`);
  running = false;
  triggerWakeUp?.();
}

// XXX: this only works as long as there are no concurrent sleeps
function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timeoutId = setTimeout(() => {
      triggerWakeUp = undefined;
      resolve();
    }, ms);

    triggerWakeUp = () => {
      clearTimeout(timeoutId);
      triggerWakeUp = undefined;
      resolve();
    };
  });
}

async function main() {
  console.log(
    `Watching ${INITIATIVES.length} initiatives for claimable rewards (polling every ${POLL_INTERVAL_MS / 1000}s)...`,
  );

  while (running) {
    console.log();
    console.log(`=== Poll started at ${new Date().toISOString()} ===`);

    for (const { address, kind } of INITIATIVES) {
      try {
        await claimForInitiative(address, kind);
      } catch (error) {
        console.error(`Error claiming for ${address}:`, error);
      }
    }

    if (!running) break;
    await sleep(POLL_INTERVAL_MS);
  }

  console.log("Exited.");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
main();
