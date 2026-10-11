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
const KNOWN_INITIATIVES_URL = "https://api.liquity.org/v2/known-initiatives/ethereum.json";

type InitiativeKind = "generic" | "merkl";
type Initiative = { kind: InitiativeKind; address: `0x${string}`; name: string };

// Initiative statuses
const NON_EXISTENT = 0;
const CLAIMABLE = 3;
const UNREGISTERABLE = 5;
const UNREGISTERED = 6;

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

const governance = getContract({
  address: GOVERNANCE,
  abi: governanceAbi,
  client,
});

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

async function fetchKnownInitiatives(): Promise<Initiative[]> {
  const response = await fetch(KNOWN_INITIATIVES_URL);
  if (!response.ok) throw new Error(`Failed to fetch known initiatives: HTTP ${response.status}`);

  const knownInitiatives = (await response.json()) as Record<string, { name?: string; group?: string }>;

  return Object.entries(knownInitiatives).map(([address, { name, group }]) => ({
    address: address as `0x${string}`,
    kind: group?.toLowerCase() === "merkl" ? "merkl" : "generic",
    name: name ?? shortAddress(address),
  }));
}

async function filterInitiativesByStatus(initiatives: Initiative[]): Promise<Initiative[]> {
  const results = await Promise.allSettled(
    initiatives.map(({ address }) => governance.read.getInitiativeState([address]).then(([status]) => status)),
  );

  const filtered: Initiative[] = [];

  for (const [initiative, result] of initiatives.map((initiative, i) => [initiative, results[i]] as const)) {
    if (result.status === "rejected") {
      console.error(`Error reading status of ${initiative.name} (${initiative.address}):`, result.reason);
      continue;
    }

    const status = result.value;

    if (status === NON_EXISTENT) {
      console.log(`Skipping non-existent initiative: ${initiative.name} (${initiative.address})`);
      continue;
    }
    if (status === UNREGISTERED) {
      console.log(`Skipping unregistered initiative: ${initiative.name} (${initiative.address})`);
      continue;
    }
    // if (status === UNREGISTERABLE) {
    //   console.log(`Unregisterable initiative ${initiative.name} (${initiative.address})`);
    //   await slack.notify(
    //     `:warning: Unregisterable initiative — ${initiative.name} ${initiativeLink(initiative.address)}`,
    //     slack.section(
    //       `:warning: *Unregisterable initiative* — ${initiative.name} ${initiativeLink(initiative.address)}`,
    //     ),
    //     slack.fields(`*Status*: ${status} (unregisterable)`),
    //   );
    //   continue; // claiming would revert in this state
    // }

    filtered.push(initiative);
  }

  return filtered;
}

async function claimForInitiative({ address, kind, name }: Initiative) {
  // get current epoch
  const currentEpoch = await governance.read.epoch();

  // skip if we already handled this initiative in this epoch during this run
  if ((handledEpoch.get(address) ?? -1n) >= currentEpoch) {
    console.log(`Already handled this epoch: ${name} (${address})`);
    return;
  }

  // get last claim epoch
  const [status, lastEpochClaim, claimableAmount] = await governance.read.getInitiativeState([address]);

  console.log();
  console.log(`Current epoch:     ${currentEpoch}`);
  console.log(`Last claim epoch:  ${lastEpochClaim}`);
  console.log(`Initiative status: ${status}`);
  console.log(`Claimable amount:  ${claimableAmount}`);

  const notifyState = (title: string) =>
    slack.notify(
      `${title} — ${name} ${initiativeLink(address)} (epoch ${currentEpoch})`,
      slack.section(`*${title}* — ${name} ${initiativeLink(address)}`),
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
    console.log(`Already claimed: ${name} (${address})`);
    handledEpoch.set(address, currentEpoch);
    await notifyState(":information_source: Already claimed");
    return;
  }
  if (status === UNREGISTERABLE) {
    console.log(`Unregisterable: ${name} (${address})`);
    handledEpoch.set(address, currentEpoch);
    await notifyState(":warning: Unregisterable");
    return;
  }
  if (claimableAmount === 0n) {
    console.log(`Nothing to claim: ${name} (${address})`);
    handledEpoch.set(address, currentEpoch);
    await notifyState(":zzz: Nothing to claim");
    return;
  }
  if (status !== CLAIMABLE) {
    console.log(`Not claimable status: ${name} (${address})`);
    handledEpoch.set(address, currentEpoch);
    await notifyState(`:warning: Not claimable (status ${status})`);
    return;
  }

  // Claim
  console.log();
  console.log(`Claiming for Initiative ${name} at ${address}`);

  let txHash;
  switch (kind) {
    case "generic":
      txHash = await governance.write.claimForInitiative([address]);
      break;
    case "merkl":
      const merklInitiative = getContract({
        address,
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

  handledEpoch.set(address, currentEpoch);
  claimCount++;

  const amount = fmtAmount(claimableAmount);
  const shortTxHash = `\`${txHash.slice(0, 10)}…${txHash.slice(-6)}\``;
  console.log(`Claimed ${amount} (${address})`);

  await slack.notify(
    `:moneybag: Claimed ${amount} — ${name} ${initiativeLink(address)} (epoch ${currentEpoch})`,
    slack.section(`:moneybag: *Claimed ${amount}* — ${name} ${initiativeLink(address)}`),
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
    `Watching initiatives from ${KNOWN_INITIATIVES_URL} for claimable rewards (polling every ${POLL_INTERVAL_MS / 1000}s)...`,
  );

  await slack.notify(
    `:rocket: Claim bot started`,
    slack.section(
      `:rocket: *Claim bot started* — watching initiatives listed on <${KNOWN_INITIATIVES_URL}|api.liquity.org> on Ethereum mainnet`,
    ),
    slack.fields(
      `*Wallet*: ${walletLink}`,
      `*Balance*: ${await getEthBalance()}`,
      `*Poll interval*: ${POLL_INTERVAL_MS / 1000}s`,
      `*Heartbeat*: every ${HEARTBEAT_INTERVAL_MS / 3_600_000}h`,
    ),
  );

  let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;

  while (running) {
    console.log();
    console.log(`=== Poll started at ${new Date().toISOString()} ===`);

    let initiatives: Initiative[] = [];

    try {
      // fetch the known initiatives again on each poll cycle, as the list may change over time
      initiatives = await fetchKnownInitiatives();
      console.log(`Fetched ${initiatives.length} known initiatives`);
    } catch (error) {
      console.error("Error fetching known initiatives:", error);

      await slack.notify(
        ":warning: Error fetching known initiatives",
        slack.section(":warning: *Error fetching known initiatives* — skipping this poll cycle"),
        slack.fields(
          `*Time*: ${new Date().toISOString()}`,
          "*Error*: " +
            "```" +
            (error instanceof Error ? error.message : String(error)).slice(0, 500).replace(/`/g, "'") +
            "```",
        ),
      );
    }

    const activeInitiatives = await filterInitiativesByStatus(initiatives);

    for (const initiative of activeInitiatives) {
      const { address } = initiative;
      try {
        await claimForInitiative(initiative);
      } catch (error) {
        console.error(`Error claiming for ${address}:`, error);

        await slack.notify(
          `:warning: Claim error for ${address}`,
          slack.section(`:warning: *Claim error* — ${initiative.name} ${initiativeLink(address)}`),
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
