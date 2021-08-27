import { loadStdlib } from '@reach-sh/stdlib';
import * as backend from './build/index.main.mjs';
import * as n2nnBackend from './build/n2nn.main.mjs';
import { yesno } from '@reach-sh/stdlib/ask.mjs';
import { runManager, runListener, runListener_ } from './announcer.mjs';
import { runTokens } from './tokens.mjs';
import { getTestNetAccount, ask } from './util.mjs';

// Track who withdrew/deposited
const withdrew  = {};
const deposited = {};
const traded = {};

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const faint = (s) => `\x1b[2m${s}\x1b[0m`

const isAOrB = (a, b) => (ans) => {
  if (ans.toLowerCase() == a.toLowerCase()) {
    return a;
  }
  if (ans.toLowerCase() == b.toLowerCase()) {
    return b;
  }
  throw Error('Only `${a}` or `${b}` are valid answers.');
}

const fmt = (stdlib, x) => stdlib.formatCurrency(x, stdlib.connector == 'ALGO' ? 6 : 18);

const getBalance = async (stdlib, tokenX, who) => {
  let tokId = tokenX.id;
  if (stdlib.connector == 'ALGO') {
    tokId = tokId ? stdlib.bigNumberify(tokId.hex).toNumber() : false;
  }
  const amt = await stdlib.balanceOf(who, tokId);
  return `${fmt(stdlib, amt)} ${tokenX.symbol}`;
};

const getBalances = async (stdlib, who, tokA, tokB) =>
  `${await getBalance(stdlib, tokA, who)} & ${await getBalance(stdlib, tokB, who)}`;

const runDuoSwapAdmin = async (useTestnet) => {

  const stdlib = await loadStdlib();

  const res = await ask(`Enter token info:`, JSON.parse);
  const tokA = res.tokA;
  const tokB = res.tokB;

  const usesNetwork = !tokA;

  let accAdmin;
  if (useTestnet) {
    stdlib.setProviderByName('TestNet');
    accAdmin = await getTestNetAccount(stdlib);
  } else {
    // Create & Fund Admin
    const startingBalance = stdlib.parseCurrency(9999);
    accAdmin = await stdlib.newTestAccount(startingBalance);
  }
  if (!usesNetwork) {
    await accAdmin.tokenAccept(tokA);
  }
  await accAdmin.tokenAccept(tokB);

  if(!useTestnet) {
    await ask(`Fund: ${stdlib.formatAddress(accAdmin)}`);
  }

  await accAdmin.setDebugLabel('Admin');

  // Deploy contract
  const poolBackend = usesNetwork ? n2nnBackend : backend;
  const ctcAdmin = accAdmin.deploy(poolBackend);
  const ctcInfo = ctcAdmin.getInfo();
  const poolAddr = (await ctcInfo).toString();
  await ask(`Enter Pool Address Into Announcer Manager: ${poolAddr}`);

  // Admin backend
  let closeToTry = null;
  const adminBackend = poolBackend.Admin(ctcAdmin, {
    tokA,
    tokB,
    conUnit: (stdlib.connector == 'ALGO') ? 1000000 : 1000000000000000000,
    shouldClosePool: async (_) => {
      if (closeToTry != null) {
        return closeToTry;
      }
      const answer = await ask(`Do you want to close the pool? (y/n)`, yesno);
      if (answer) {
        closeToTry = { when: answer, msg: null };;
      }
      return { when: answer, msg: null };
    },
  });

  await Promise.all([ adminBackend ]);
};

const runDuoSwapLP = async (useTestnet) => {

  const stdlib = await loadStdlib();
  let accProvider;
  if (useTestnet) {
    stdlib.setProviderByName('TestNet');
    accProvider = await getTestNetAccount(stdlib);
  } else {
    // Create & Fund Provider
    const startingBalance = stdlib.parseCurrency(9999);
    accProvider = await stdlib.newTestAccount(startingBalance);
  }

  await accProvider.setDebugLabel('Provider');
  if (stdlib.connector == 'ETH') {
    accProvider.setGasLimit(5000000);
  }

  // Connect to announcer and list pools:
  const listenerInfo = await ask(`Paste Announcer Contract Info:`);
  console.log(`Searching for pools...`)
  try {
    const listener = runListener_(stdlib, accProvider, listenerInfo);
    await Promise.all([ (new Promise(async (resolve, reject) => {
      const _ = await ask(`Click \x1b[1m\`Enter\`\x1b[0m when done searching for pools.`);
      reject();
    })), listener() ]);
  } catch (e) { if (e != undefined) console.log(`error received:`, e) }

  const { tokA, tokB, poolAddr } = await ask(`Enter connection info:`, JSON.parse);

  const usesNetwork = !tokA.id;

  if (!usesNetwork) {
    await accProvider.tokenAccept(tokA.id);
  }
  await accProvider.tokenAccept(tokB.id);

  if (!useTestnet) {
    const _ = await ask(`Fund: ${stdlib.formatAddress(accProvider)}`);
  }

  const poolBackend = usesNetwork ? n2nnBackend : backend;

  const ctcProvider = accProvider.attach(poolBackend, stdlib.connector == 'ALGO' ? parseInt(poolAddr) : poolAddr);

  let withdrawToTry = null;
  let depositToTry  = null;

  const backendProvider = poolBackend.Provider(ctcProvider, {
    log: (s, x) => { console.log(s.padStart(30), x.toString()); },
    acceptToken: async (tokId) => {
      await accProvider.tokenAccept(tokId);
    },
    withdrawDone: (isMe, amtOuts) => {
      if (isMe) {
        withdrawToTry = null;
        withdrew[accProvider] = true;
        console.log("\x1b[31m", `I withdrew ${fmt(stdlib, amtOuts[0])} ${tokA.symbol} & ${fmt(stdlib, amtOuts[1])} ${tokB.symbol}`,'\x1b[0m');
      }
    },
    withdrawMaybe: async ([ alive, market ]) => {
      if (withdrawToTry != null) {
        return withdrawToTry;
      }
      const wantsToWithdraw = await ask(`Do you want to withdraw liquidity? (y/n)`, yesno);
      if (wantsToWithdraw) {
        const amt = await ask(`How much liquidity do you want to withdraw?`);
        withdrawToTry = { when: true, msg: { liquidity: stdlib.parseCurrency(amt) } };
        return withdrawToTry;
      } else {
        return { when: false, msg: { liquidity: 0 }};
      }
    },
    depositDone: (isMe, amtA, amtB, poolTokens) => {
      if (isMe) {
        depositToTry = null;
        deposited[accProvider] = poolTokens;
        console.log("\x1b[34m", `I received ${fmt(stdlib, poolTokens)} pool tokens for my deposit of ${fmt(stdlib, amtA)} ${tokA.symbol} & ${fmt(stdlib, amtB)} ${tokB.symbol}`,'\x1b[0m');
      }
    },
    depositMaybe: async ([ isAlive, market ]) => {
      if (depositToTry != null) {
        return depositToTry;
      }
      const wantsToDeposit = await ask(`Do you want to deposit? (y/n)`, yesno);
      if (wantsToDeposit) {
        const myBals = await getBalances(stdlib, accProvider, tokA, tokB);
        const amtA = await ask(`How much ${tokA.symbol} do you want to deposit? (Bal: ${myBals})`);
        const amtB = await ask(`How much ${tokB.symbol} do you want to deposit? (Bal: ${myBals})`);
        const deposit = { amtA: stdlib.parseCurrency(amtA), amtB: stdlib.parseCurrency(amtB) }
        depositToTry = {
          when: true, msg: deposit
        };
        return depositToTry;
      } else {
        return { when: false, msg: { amtA: 0, amtB: 0 }};
      }
    },
  });

  await Promise.all([ backendProvider ]);
}

// True: token is tokA, False: token is tokB
const compareTokens = (stdlib, token, tokenId) => {
  if (token[0] == 'None') {
    return true;
  }
  return (stdlib.connector == 'ALGO') ? token[1].eq(tokenId || 0) : (token[1] == tokenId)
}

const maybeTok = (tokA) =>
  (!tokA.id)
    ? ['None', null]
    : ['Some', tokA.id];

const runDuoSwapTrader = async (useTestnet) => {

  const stdlib = await loadStdlib();
  let accTrader;
  if (useTestnet) {
    stdlib.setProviderByName('TestNet');
    accTrader = await getTestNetAccount(stdlib);
  } else {
    // Create & Fund Trader
    const startingBalance = stdlib.parseCurrency(9999);
    accTrader = await stdlib.newTestAccount(startingBalance);
  }

  await accTrader.setDebugLabel('Trader');
  if (stdlib.connector == 'ETH') {
    accTrader.setGasLimit(5000000);
  }

  // Connect to announcer and list pools:
  const listenerInfo = await ask(`Paste Announcer Contract Info:`);
  console.log(`Searching for pools...`)
  try {
    const listener = await runListener_(stdlib, accTrader, listenerInfo);
    await Promise.all([ (new Promise(async (resolve, reject) => {
      const _ = await ask(`Click \x1b[1m\`Enter\`\x1b[0m when done searching for pools.`);
      reject();
    })), listener() ]);
  } catch (e) { if (e != undefined) console.log(`error received:`, e) }

  // tokA will equal { id: null, ... } if network token
  const { tokA, tokB, poolAddr } = await ask(`Enter connection info:`, JSON.parse);

  const usesNetwork = !tokA.id;

  if (!usesNetwork) {
    await accTrader.tokenAccept(tokA.id); }
  await accTrader.tokenAccept(tokB.id);

  if (!useTestnet) {
    const _ = await ask(`Fund: ${stdlib.formatAddress(accTrader)}`);
  }

  const poolBackend = usesNetwork ? n2nnBackend : backend;

  const ctcTrader = accTrader.attach(poolBackend, stdlib.connector == 'ALGO' ? parseInt(poolAddr) : poolAddr);

  let tradeToTry = null;

  const backendTrader = poolBackend.Trader(ctcTrader, {
    log: (s, x) => { console.log(s.padStart(30), x.toString()); },
    acceptToken: async (tokId) => {
      await accTrader.tokenAccept(tokId);
    },
    tradeDone: (isMe, [amtIn, amtInTok, amtOut, amtOutTok]) => {
      const tokIn  = compareTokens(stdlib, amtInTok, tokA.id) ? tokA : tokB;
      const tokOut = compareTokens(stdlib, amtOutTok, tokA.id) ? tokA : tokB;
      if (isMe) {
        tradeToTry = null;
        traded[accTrader] = true;
        console.log("\x1b[32m", `I traded ${fmt(stdlib, amtIn)} ${tokIn.symbol} for ${fmt(stdlib, amtOut)} ${tokOut.symbol}`, '\x1b[0m');
      }
    },
    tradeMaybe: async ([ alive, market ]) => {
      if (tradeToTry != null) {
        return tradeToTry;
      }
      const wantsToTrade = await ask(`Do you want to trade? (y/n)`, yesno);
      if (wantsToTrade) {
        const options = [tokA.symbol, tokB.symbol].join('\n');
        const tokType = await ask(`What token do you want to input?\n${options}`, isAOrB(tokA.symbol, tokB.symbol));
        const myBal = await getBalance(stdlib, tokType === tokA.symbol ? tokA : tokB, accTrader);
        const amt = await ask(`How much do you want to trade? (You have ${myBal})`);
        const trade =
          (tokType == tokA.symbol)
            ? ({ amtA: stdlib.parseCurrency(amt), amtB: 0, amtInTok: maybeTok(tokA) })
            : ({ amtA: 0, amtB: stdlib.parseCurrency(amt), amtInTok: ['Some', tokB.id] });
        tradeToTry = { when: true, msg: trade };
        return tradeToTry;
      } else {
        return { when: false, msg: { amtA: 0, amtB: 0, amtInTok: ['None', null] }};
      }
    },
  });

  await Promise.all([ backendTrader ]);
}

const options = [
  `1: ` + bold(`DuoSwap Pool Admin`) + `\n` + faint(`  * Create a pool for a pair of tokens`),
  `2: ` + bold(`DuoSwap Liquidity Provider`) + `\n` + faint(`  * Receive liquidity tokens by depositing tokens into a pool\n  * Withdraw liquidity from a pool`),
  `3: ` + bold(`DuoSwap Trader`) + `\n` + faint(`  * Trade one token for another in available pools`),
  `4: ` + bold(`DuoSwap Announcer`) + `\n` + faint(`  * Announces all the available pool addresses`),
  `5: ` + bold(`DuoSwap Listener`) + `\n` + faint(`  * Listens for all the available pool addresses`),
  `6: ` + bold(`DuoSwap Token Funder`) + `\n` + faint(`  * Create 2 tokens and fund any addresses you provide`),
].join('\n');

export const runInteractive = async (useTestnet) => {
  const answer = await ask(`Who are you?\n${options}`, parseInt);

  switch (answer) {
    case 1: {
      // Creates a pool and sends info to announcer/cache
      await runDuoSwapAdmin(useTestnet);
      return;
    }
    case 2: {
      await runDuoSwapLP(useTestnet);
      return;
    }
    case 3: {
      await runDuoSwapTrader(useTestnet);
      return;
    }
    case 4: {
      await runManager(useTestnet);
      return;
    }
    case 5: {
      await runListener(useTestnet);
      return;
    }
    case 6: {
      await runTokens(useTestnet);
      return;
    }
  }
}
