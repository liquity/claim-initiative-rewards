import { subtract, greaterThanOrEqual, format as formatDnum } from "dnum";
import { type Address, createPublicClient, createWalletClient, getContract, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import governanceAbi from "./governance.abi";
import merklInitiativeAbi from "./merklInitiative.abi";
import * as slack from "./slack";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5 * 60 * 1000); // 5 minutes
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const GOVERNANCE = "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1";

type InitiativeKind = "generic" | "merkl";
type Initiative = { kind: InitiativeKind; address: `0x${string}` };

const INITIATIVES: Initiative[] = [
  { kind: "generic", address: "0xba415afa8fcd65196764b5e08cb4dbf90bee33b4" }, // Curve BOLD/USDC
  { kind: "generic", address: "0x0c76eae597afa2aa163a8c845f7e7e870256ac7e" }, // Curve BOLD/LUSD
  { kind: "generic", address: "0x69efec83296c711db4a403b1ee281e87f99590d6" }, // Curve BOLD/USDC Bribes (Votium)
  { kind: "generic", address: "0x865c61e03b35975d25442f60ce4621db1e349a2f" }, // IPOR Carry Vault
  { kind: "merkl", address: "0xB42448852A1BFc99d66ed53C65e2B49cF954f615" }, // Uniswap V4 BOLD/USDC (Merkl)
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

const startedAt = Date.now();
let pollCount = 0;
let claimCount = 0;

const handledEpoch = new Map<Address, bigint>(); // epochs already handled per initiative, in-memory, reset on restart

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const initiativeLink = (address: Address) => `<https://etherscan.io/address/${address}|\`${shortAddress(address)}\`>`;
const fmtAmount = (amount: bigint) => formatDnum([amount, 18], { digits: 4, trailingZeros: false });
const walletLink = `<https://etherscan.io/address/${client.wallet.account.address}|\`${shortAddress(client.wallet.account.address)}\`>`;

function fmtDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000) % 60;
  const hours = Math.floor(ms / 3_600_000) % 24;
  const days = Math.floor(ms / 86_400_000);
  return (days > 0 ? `${days}d ` : "") + (hours > 0 || days > 0 ? `${hours}h ` : "") + `${minutes}m`;
}

async function getEthBalance(): Promise<string> {
  const balance = await client.public.getBalance({ address: client.wallet.account.address });
  return `${fmtAmount(balance)} ETH`;
}

async function claimForInitiative(initiative: Address, kind: InitiativeKind = "generic") {
  const governance = getContract({
    address: GOVERNANCE,
    abi: governanceAbi,
    client,
  });

  // get current epoch
  const currentEpoch = await governance.read.epoch();

  // skip if we already handled this initiative in this epoch during this run
  if ((handledEpoch.get(initiative) ?? -1n) >= currentEpoch) {
    console.log(`Already handled this epoch (${initiative})`);
    return;
  }

  // get last claim epoch
  const [status, lastEpochClaim, claimableAmount] = await governance.read.getInitiativeState([initiative]);

  console.log();
  console.log(`Current epoch:     ${currentEpoch}`);
  console.log(`Last claim epoch:  ${lastEpochClaim}`);
  console.log(`Initiative status: ${status}`);
  console.log(`Claimable amount:  ${claimableAmount}`);

  const notifyState = (title: string) =>
    slack.notify(
      `${title} — ${initiativeLink(initiative)} (epoch ${currentEpoch})`,
      slack.section(`*${title}* — ${initiativeLink(initiative)}`),
      slack.fields(
        `*Current epoch*: ${currentEpoch}`,
        `*Last claim epoch*: ${lastEpochClaim}`,
        `*Initiative status*: ${status}${status == CLAIMABLE ? " (claimable)" : ""}`,
        `*Claimable amount*: ${fmtAmount(claimableAmount)}`,
      ),
    );

  // TODO: in case of Merkl initiatives, someone could have claimed directly through Governance,
  // in which case we still need to create the campaign. How to detect this best?
  if (lastEpochClaim >= currentEpoch - 1n) {
    console.log(`Already claimed (${initiative})`);
    handledEpoch.set(initiative, currentEpoch);
    await notifyState(":information_source: Already claimed");
    return;
  }
  if (claimableAmount === 0n) {
    console.log(`Nothing to claim (${initiative})`);
    handledEpoch.set(initiative, currentEpoch);
    await notifyState(":zzz: Nothing to claim");
    return;
  }
  if (status != CLAIMABLE) {
    console.log(`Not claimable status (${initiative})`);
    handledEpoch.set(initiative, currentEpoch);
    await notifyState(`:warning: Not claimable (status ${status})`);
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

  handledEpoch.set(initiative, currentEpoch);
  claimCount++;

  const amount = fmtAmount(claimableAmount);
  const shortTxHash = `\`${txHash.slice(0, 10)}…${txHash.slice(-6)}\``;
  console.log(`Claimed ${amount} (${initiative})`);

  await slack.notify(
    `:moneybag: Claimed ${amount} — ${initiativeLink(initiative)} (epoch ${currentEpoch})`,
    slack.section(`:moneybag: *Claimed ${amount}* — ${initiativeLink(initiative)}`),
    slack.fields(
      `*Current epoch*: ${currentEpoch}`,
      `*Claim epoch*: ${currentEpoch - 1n}`,
      `*Amount*: ${amount}`,
      `*TX*: <https://etherscan.io/tx/${txHash}|${shortTxHash}>`,
    ),
  );
}

let running = true;
let shutdownSignalCount = 0;
let triggerWakeUp: (() => void) | undefined;

function shutdown(signal: string) {
  if (++shutdownSignalCount > 1) {
    console.log(`Received ${signal} again, exiting prematurely.`);
    process.exit(1);
  }

  console.log(`Received ${signal}, shutting down after current poll... (send ${signal} again to exit prematurely)`);
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

  await slack.notify(
    `:rocket: Claim bot started — watching ${INITIATIVES.length} initiatives`,
    slack.section(`:rocket: *Claim bot started* — watching *${INITIATIVES.length}* initiatives on Ethereum mainnet`),
    slack.fields(
      `*Wallet*: ${walletLink}`,
      `*Balance*: ${await getEthBalance()}`,
      `*Poll interval*: ${POLL_INTERVAL_MS / 1000}s`,
      `*Heartbeat*: every ${HEARTBEAT_INTERVAL_MS / 3_600_000}h`,
    ),
    slack.section(
      [
        "*Initiatives*:",
        ...INITIATIVES.map(
          ({ address, kind }) =>
            `• ${initiativeLink(address)} ${kind === "generic" ? "_(Generic)_" : kind === "merkl" ? "_(Merkl)_" : ""}`,
        ),
      ].join("\n"),
    ),
  );

  let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;

  while (running) {
    console.log();
    console.log(`=== Poll started at ${new Date().toISOString()} ===`);

    for (const { address, kind } of INITIATIVES) {
      try {
        await claimForInitiative(address, kind);
      } catch (error) {
        console.error(`Error claiming for ${address}:`, error);

        await slack.notify(
          `:warning: Claim error for ${address}`,
          slack.section(`:warning: *Claim error* — ${initiativeLink(address)}`),
          slack.fields(
            `*Time*: ${new Date().toISOString()}`,
            "*Error*: " +
              "```" +
              (error instanceof Error ? error.message : String(error)).slice(0, 500).replace(/`/g, "'") +
              "```",
          ),
        );
      }
    }

    pollCount++;

    if (Date.now() >= nextHeartbeatAt) {
      nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
      const uptime = fmtDuration(Date.now() - startedAt);
      console.log(`Sending ${HEARTBEAT_INTERVAL_MS / 3_600_000}h heartbeat notification...`);

      await slack.notify(
        `:heartpulse: Claim bot heartbeat — uptime ${uptime}, ${pollCount} polls, ${claimCount} claims`,
        slack.section(":heartpulse: *Claim bot heartbeat* — still alive"),
        slack.fields(
          `*Uptime*: ${uptime}`,
          `*Polls*: ${pollCount}`,
          `*Claims*: ${claimCount}`,
          `*Wallet*: ${walletLink}`,
          `*Balance*: ${await getEthBalance()}`,
        ),
      );
    }

    if (!running) break;
    await sleep(POLL_INTERVAL_MS);
  }

  console.log("Exited.");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
main();
