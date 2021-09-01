import { loadStdlib } from '@reach-sh/stdlib';
import launchToken from '@reach-sh/stdlib/launchToken.mjs';
import * as backend from './build/index.main.mjs';
import { runInteractive } from './interactive.mjs';
const stdlib = loadStdlib(process.env);

const NUM_PROVIDERS = 3;
const NUM_TRADERS = 2;

export const runAutomated = async () => {
  const maxTrade = { ALGO: 50_000, ETH: 50_000, CFX: 5 }[stdlib.connector];
  const maxDeposit = { ALGO: 10_000_000, ETH: 10_000_000, CFX: 100 }[stdlib.connector];
  const startBal = { ALGO: 30_000_000, ETH: 30_000_000, CFX: 300 }[stdlib.connector];

  const startingBalance = stdlib.parseCurrency(startBal);
  const fmt = (x) => stdlib.formatCurrency(x, (stdlib.connector == 'ALGO') ? 6 : 18);


  // Create tokens to swap
  const accCreator = await stdlib.newTestAccount(startingBalance);
  const zmd = await launchToken(stdlib, accCreator, "zorkmid", "ZMD");
  const gil = await launchToken(stdlib, accCreator, "gil", "GIL");


  // Supply ZMD and GIL to account
  const gimmeTokens = async (acc) => {
    if (stdlib.connector == 'ALGO') {
      await acc.tokenAccept(zmd.id);
      await acc.tokenAccept(gil.id);
    }
    await zmd.mint(acc, startingBalance);
    await gil.mint(acc, startingBalance);
  }


  // Create & Fund Admin
  const accAdmin = await stdlib.newTestAccount(startingBalance)
  await accAdmin.setDebugLabel('Admin');
  await gimmeTokens(accAdmin);


  // Create & Fund Providers
  const accProviders = await Promise.all(
    Array.from({ length: NUM_PROVIDERS }, () =>
      stdlib.newTestAccount(startingBalance))
  );

  for (let i = 0; i < accProviders.length; ++i) {
    const accProvider = accProviders[i];
    await accProvider.setDebugLabel(`Provider ${i}`);
    await gimmeTokens(accProvider);
  }

  // Create & Fund Traders
  const accTraders = await Promise.all(
    Array.from({ length: NUM_TRADERS }, () =>
      stdlib.newTestAccount(startingBalance))
  );

  for (let i = 0; i < accTraders.length; ++i) {
    const accTrader = accTraders[i];
    await accTrader.setDebugLabel(`Trader ${i}`);
    await gimmeTokens(accTrader);
  }

  // Deploy contract
  const ctcAdmin = accAdmin.deploy(backend);
  const ctcInfo = ctcAdmin.getInfo();


  // Track who withdrew/deposited
  const withdrew  = {};
  const deposited = {};
  const traded = {};
  const toks = {
    [zmd.id]: "ZMD",
    [gil.id]: "GIL"
  };

  const didEveryoneTrade = () => Object.keys(traded).every(k => traded[k] == true);
  const didEveryoneDeposit = () => Object.keys(deposited).every(k => deposited[k] != false);

  // Admin backend
  const adminBackend = backend.Admin(ctcAdmin, {
    tokA: zmd.id,
    tokB: gil.id,
    // We use these numbers to divide the initial payments when performing
    // the initial mint (to avoid overflow on ALGO).
    // This adds the constraint that initial deposit of pool must not contain fractional numbers.
    conUnit: (stdlib.connector == 'ALGO') ? 1000000 : 1000000000000000000,
    shouldClosePool: ([ isAlive, market ]) => {
      const everyoneWent =
        Object.keys(withdrew).every(k => withdrew[k] == true) &&
        didEveryoneTrade();
      return { when: everyoneWent, msg: null };
    },
  });


  // Provider backends
  const provBackends = accProviders.map((accProvider, i) => {
    const ctcProvider = accProvider.attach(backend, ctcInfo);
    const who = `Provider ${i}`;
    withdrew[who] = false;
    deposited[who] = false;
    return backend.Provider(ctcProvider, {
      log: (s, x) => {
        console.log(s.padStart(30), x.toString());
      },
      acceptToken: async (tokId) => {
        console.log(`${who} accepts token ${tokId}`);
        await accProvider.tokenAccept(tokId);
      },
      withdrawDone: (isMe, amtOuts) => {
        if (isMe) {
          withdrew[who] = true;
          console.log("\x1b[31m", `${who} withdrew ${fmt(amtOuts[0])} ZMD & ${fmt(amtOuts[1])} GIL`,'\x1b[0m');
        }
      },
      withdrawMaybe: ([ alive, market ]) => {
        if (withdrew[who] == false && deposited[who] && didEveryoneTrade()) {
          console.log("\x1b[31m", `${who} tries to withdraw ${fmt(deposited[who])} liquidity`,'\x1b[0m');
          return { when: true, msg: { liquidity: deposited[who] } };
        } else {
          return { when: false, msg: { liquidity: 0 }};
        }
      },
      depositMaybe: ([ isAlive, market ]) => {
        if (deposited[who] == false) {
          const amt = Math.floor(Math.random() * maxDeposit) + 10;
          const deposit = {
            amtA: stdlib.parseCurrency(amt * 2),
            amtB: stdlib.parseCurrency(amt),
          };
          console.log("\x1b[34m", `${who} tries to deposit: ${fmt(deposit.amtA)} ZMD & ${fmt(deposit.amtB)} GIL`,'\x1b[0m');
          return { when: true, msg: deposit };
        } else {
          return { when: false, msg: { amtA: 0, amtB: 0 }};
        }
      },
      depositDone: (isMe, amtA, amtB, poolTokens) => {
        if (isMe) {
          deposited[who] = poolTokens;
          console.log("\x1b[34m", `${who} received ${fmt(poolTokens)} pool tokens for their deposit of ${fmt(amtA)} ZMD & ${fmt(amtB)} GIL`,'\x1b[0m');
        }
      },
    });
  });

  const traderBackends = accTraders.map((accTrader, i) => {
    const ctcTrader = accTrader.attach(backend, ctcInfo);
    const who = `Trader ${i}`;
    traded[who] = false;
    return backend.Trader(ctcTrader, {
      log: (s, x) => {
        console.log(s.padStart(30), x.toString());
      },
      logMarket: (s, x) => {
        console.log(s.padStart(30), x.k.toString());
      },
      acceptToken: async (tokId) => {
        console.log(`${who} accepts token ${tokId}`);
        await accTrader.tokenAccept(tokId);
      },
      tradeMaybe: ([ alive, market ]) => {
        const idx = Math.floor(Math.random() * 2);
        const amt = stdlib.parseCurrency(Math.floor(Math.random() * maxTrade) + 1);

        const trade =
          (idx == 0)
            ? ({
              amtA: amt,
              amtB: 0,
              amtInTok: ['Some', zmd.id],
            })
          : ({
              amtA: 0,
              amtB: amt,
              amtInTok: ['Some', gil.id],
            });

        const didNotTrade = traded[who] == false;
        if (didNotTrade) {
          console.log("\x1b[32m", `${who} tries to trade ${fmt(amt)} ${toks[trade.amtInTok[1]]}`,'\x1b[0m')
        }
        return { when: didNotTrade, msg: trade };
      },
      tradeDone: (isMe, [amtIn, amtInTok, amtOut, amtOutTok]) => {
        if (isMe) {
          traded[who] = true;
          console.log("\x1b[32m", `${who} traded ${fmt(amtIn)} ${toks[amtInTok[1]]} for ${fmt(amtOut)} ${toks[amtOutTok[1]]}`,'\x1b[0m');
        }
      }
    });
  });

  const backends = [ adminBackend, provBackends, traderBackends ];
  await Promise.all(backends);

  console.log(`Duoswap finished`);
};

(async () => {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    await runInteractive(args.includes(`testnet`));
  } else {
    await runAutomated();
  }
  process.exit();
})();
