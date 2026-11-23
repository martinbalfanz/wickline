// Tests for the heatmap's markets: crypto and stock markets outside the US (lib/heatmap-markets.mjs),
// and the panel's market, period, size and currency helpers (public/js/heatmap.js). Uses responses
// recorded from Yahoo's screener, CoinGecko and Binance (trimmed); no network.
import assert from 'node:assert/strict';
import {
  shapeStocks, turnover, isPegged, binanceProducts, binancePrices, shapeCoins, coinCategory, rankTier, changeOver,
  marketCurrency, HEATMAP_MARKETS,
} from '../lib/heatmap-markets.mjs';
import { usCountries } from '../lib/markets.mjs';
import { MARKETS, sizesFor, pickSize, periodsAvailable, money } from '../public/js/heatmap.js';
import { startServer } from '../server.mjs';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

// Recorded samples (November 2026), trimmed to the fields used.
const REC = {
  // Yahoo screener, exchange LSE
  gb: [
    { symbol: 'TYT.L', longName: 'Toyota Motor Corporation', shortName: 'TOYOTA MOTOR CORPORATION Y50', quoteType: 'EQUITY', currency: 'JPY', marketCap: 39069304225792, regularMarketPrice: 3329, regularMarketChangePercent: -2.4612, fiftyTwoWeekChangePercent: 9.4176, averageDailyVolume3Month: 67072 },
    { symbol: 'HSBA.L', longName: 'HSBC Holdings plc', shortName: 'HSBC HOLDINGS PLC ORD $0.50 (UK', quoteType: 'EQUITY', currency: 'GBp', marketCap: 210824462336, regularMarketPrice: 1234, regularMarketChangePercent: -3.6239, fiftyTwoWeekChangePercent: 17.7481, averageDailyVolume3Month: 21812532 },
    { symbol: 'AZN.L', longName: 'AstraZeneca PLC', shortName: 'ASTRAZENECA PLC ORD SHS $0.25', quoteType: 'EQUITY', currency: 'GBp', marketCap: 208009084928, regularMarketPrice: 13412, regularMarketChangePercent: 0.8118, fiftyTwoWeekChangePercent: -3.7462, averageDailyVolume3Month: 2744967 },
    { symbol: '0R2V.L', longName: 'Apple Inc.', shortName: 'APPLE INC APPLE ORD', quoteType: 'EQUITY', currency: 'USD', marketCap: 5153045348352, regularMarketPrice: 344.08, regularMarketChangePercent: -1.3702, fiftyTwoWeekChangePercent: 24.5855, averageDailyVolume3Month: 174340 },
    { symbol: 'SHEL.L', longName: 'Shell plc', shortName: 'SHELL PLC ORD EUR0.07', quoteType: 'EQUITY', currency: 'GBp', marketCap: 201786523648, regularMarketPrice: 3574.5, regularMarketChangePercent: 0, fiftyTwoWeekChangePercent: 28.9502, averageDailyVolume3Month: 10319659 },
    { symbol: 'BNC.L', longName: 'Banco Santander, S.A.', shortName: 'BANCO SANTANDER S.A. ORD EUR0.5', quoteType: 'EQUITY', currency: 'GBp', marketCap: 124466872320, regularMarketPrice: 864, regularMarketChangePercent: -2.0408, fiftyTwoWeekChangePercent: 11.054, averageDailyVolume3Month: 2677822 },
    { symbol: 'BP.L', longName: 'BP p.l.c.', shortName: 'BP PLC $0.25', quoteType: 'EQUITY', currency: 'GBp', marketCap: 84965613568, regularMarketPrice: 549.8, regularMarketChangePercent: -0.1272, fiftyTwoWeekChangePercent: 21.1414, averageDailyVolume3Month: 46122742 },
    { symbol: 'BP-A.L', longName: 'BP p.l.c.', shortName: 'BP PLC 8% CUM 1ST PRF #1', quoteType: 'EQUITY', currency: 'GBp', regularMarketPrice: 139, regularMarketChangePercent: 0.361, fiftyTwoWeekChangePercent: -7.947, averageDailyVolume3Month: 5532 },
    { symbol: 'MNTS.L', longName: 'The Schiehallion Fund Limited', shortName: 'THE SCHIEHALLION FUND LIMITED O', quoteType: 'EQUITY', currency: 'GBp', marketCap: 1643585920, regularMarketPrice: 162, regularMarketChangePercent: -0.9174, fiftyTwoWeekChangePercent: -35.2854, averageDailyVolume3Month: 105386 },
    { symbol: 'BC94.L', longName: 'Samsung Electronics Co., Ltd.', shortName: 'SAMSUNG ELECTRONICS CO LTD (ATT', quoteType: 'EQUITY', currency: 'USD', marketCap: 844987695104, regularMarketPrice: 3244, regularMarketChangePercent: -10.6336, fiftyTwoWeekChangePercent: 94.8348, averageDailyVolume3Month: 10688 },
  ],
  // Yahoo screener, exchange GER (Xetra)
  de: [
    { symbol: 'APC.DE', longName: 'Apple Inc.', shortName: 'Apple Inc.                    R', quoteType: 'EQUITY', currency: 'EUR', marketCap: 4591443247104, regularMarketPrice: 315.95, regularMarketChangePercent: -0.8006, fiftyTwoWeekChangePercent: 32.3074, averageDailyVolume3Month: 19343 },
    { symbol: 'SAP.DE', longName: 'SAP SE', shortName: 'SAP SE                        I', quoteType: 'EQUITY', currency: 'EUR', marketCap: 212004241408, regularMarketPrice: 183.68, regularMarketChangePercent: -1.7859, fiftyTwoWeekChangePercent: -11.4795, averageDailyVolume3Month: 2219053 },
    { symbol: 'ASME.DE', longName: 'ASML Holding N.V.', shortName: 'ASML Holding N.V.             A', quoteType: 'EQUITY', currency: 'EUR', marketCap: 450784559104, regularMarketPrice: 1169.6, regularMarketChangePercent: -9.2066, fiftyTwoWeekChangePercent: 36.2535, averageDailyVolume3Month: 4389 },
    { symbol: 'NOA3.DE', longName: 'Nokia Oyj', shortName: 'Nokia Oyj                     R', quoteType: 'EQUITY', currency: 'EUR', marketCap: 36386955264, regularMarketPrice: 6.43, regularMarketChangePercent: -9.1551, fiftyTwoWeekChangePercent: 23.7967, averageDailyVolume3Month: 679714 },
    { symbol: 'HEN3.DE', longName: 'Henkel AG & Co. KGaA', shortName: 'Henkel AG & Co. KGaA          I', quoteType: 'EQUITY', currency: 'EUR', marketCap: 34703818752, regularMarketPrice: 85.72, regularMarketChangePercent: -0.2328, fiftyTwoWeekChangePercent: 23.3736, averageDailyVolume3Month: 376330 },
    { symbol: 'HEN.DE', longName: 'Henkel AG & Co. KGaA', shortName: 'Henkel AG & Co. KGaA          I', quoteType: 'EQUITY', currency: 'EUR', marketCap: 31436673024, regularMarketPrice: 77.65, regularMarketChangePercent: -0.5762, fiftyTwoWeekChangePercent: 19.8303, averageDailyVolume3Month: 70681 },
    { symbol: '22UA.DE', longName: 'BioNTech SE', shortName: 'BioNTech SE                   N', quoteType: 'EQUITY', currency: 'EUR', marketCap: 18272305152, regularMarketPrice: 73.7, regularMarketChangePercent: -1.7333, fiftyTwoWeekChangePercent: -12.987, averageDailyVolume3Month: 29963 },
  ],
  // Yahoo screener, exchange SAO
  br: [
    { symbol: 'AAPL34.SA', longName: 'Apple Inc.', shortName: 'APPLE       DRN ED', quoteType: 'EQUITY', currency: 'BRL', marketCap: 29997330857984, regularMarketPrice: 103.21, regularMarketChangePercent: -0.4149, fiftyTwoWeekChangePercent: 38.3327, averageDailyVolume3Month: 401049 },
    { symbol: 'PETR4.SA', longName: 'Petróleo Brasileiro S.A. - Petrobras', shortName: 'PETROBRAS   PN      N2', quoteType: 'EQUITY', currency: 'BRL', marketCap: 583020904448, regularMarketPrice: 42.67, regularMarketChangePercent: -1.1582, fiftyTwoWeekChangePercent: 31.1309, averageDailyVolume3Month: 49955632 },
    { symbol: 'KNCR11.SA', longName: 'Kinea Rendimentos Imobiliários Fundo de Investimento Imobiliário - FII', shortName: 'FII KINEA RICI', quoteType: 'EQUITY', currency: 'BRL', marketCap: 7873336832, regularMarketPrice: 102.85, regularMarketChangePercent: -0.1553, fiftyTwoWeekChangePercent: -2.6226, averageDailyVolume3Month: 272168 },
  ],
  // CoinGecko /coins/markets (wrapped and staked copies added: CoinGecko ranks them only at times)
  coins: [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 61066, market_cap: 1228403625518, price_change_percentage_24h_in_currency: 1.605, price_change_percentage_7d_in_currency: -6.3095, price_change_percentage_30d_in_currency: -24.5585, price_change_percentage_1y_in_currency: -27.742 },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 1714.02, market_cap: 209525288581, price_change_percentage_24h_in_currency: 1.93092, price_change_percentage_7d_in_currency: -6.4148, price_change_percentage_30d_in_currency: -28.0073, price_change_percentage_1y_in_currency: -37.9787 },
    { id: 'tether', symbol: 'usdt', name: 'Tether', current_price: 0.998634, market_cap: 174599589485, price_change_percentage_24h_in_currency: 0.01684, price_change_percentage_7d_in_currency: -0.0905, price_change_percentage_30d_in_currency: -0.0499, price_change_percentage_1y_in_currency: -0.0965 },
    { id: 'wrapped-bitcoin', symbol: 'wbtc', name: 'Wrapped Bitcoin', current_price: 61004.934, market_cap: 8000000000, price_change_percentage_24h_in_currency: 1.605, price_change_percentage_7d_in_currency: -6.3095, price_change_percentage_30d_in_currency: -24.5585, price_change_percentage_1y_in_currency: -27.742 },
    { id: 'staked-ether', symbol: 'steth', name: 'Lido Staked Ether', current_price: 1710.59196, market_cap: 30000000000, price_change_percentage_24h_in_currency: 1.93092, price_change_percentage_7d_in_currency: -6.4148, price_change_percentage_30d_in_currency: -28.0073, price_change_percentage_1y_in_currency: -37.9787 },
    { id: 'wrapped-steth', symbol: 'wsteth', name: 'Wrapped stETH', current_price: 2091.1043999999997, market_cap: 12000000000, price_change_percentage_24h_in_currency: 1.93092, price_change_percentage_7d_in_currency: -6.4148, price_change_percentage_30d_in_currency: -28.0073, price_change_percentage_1y_in_currency: -37.9787 },
    { id: 'binancecoin', symbol: 'bnb', name: 'BNB', current_price: 558.11, market_cap: 73396656247, price_change_percentage_24h_in_currency: 1.61716, price_change_percentage_7d_in_currency: -6.2349, price_change_percentage_30d_in_currency: -24.3036, price_change_percentage_1y_in_currency: -32.8885 },
    { id: 'usd-coin', symbol: 'usdc', name: 'USDC', current_price: 0.99934, market_cap: 68395453402, price_change_percentage_24h_in_currency: 0.00438, price_change_percentage_7d_in_currency: -0.0363, price_change_percentage_30d_in_currency: -0.036, price_change_percentage_1y_in_currency: -0.0334 },
    { id: 'ripple', symbol: 'xrp', name: 'XRP', current_price: 0.921182, market_cap: 58510366829, price_change_percentage_24h_in_currency: -0.85638, price_change_percentage_7d_in_currency: -5.2817, price_change_percentage_30d_in_currency: -28.6905, price_change_percentage_1y_in_currency: -52.6705 },
    { id: 'figure-heloc', symbol: 'figr_heloc', name: 'Figure Heloc', current_price: 1.056, market_cap: 28644056454, price_change_percentage_24h_in_currency: -1.12395, price_change_percentage_7d_in_currency: -0.9111, price_change_percentage_30d_in_currency: 2.8164, price_change_percentage_1y_in_currency: 2.646 },
    { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', current_price: 0.054917, market_cap: 8614285942, price_change_percentage_24h_in_currency: -0.396, price_change_percentage_7d_in_currency: -8.1325, price_change_percentage_30d_in_currency: -29.9897, price_change_percentage_1y_in_currency: -60.7941 },
    { id: 'leo-token', symbol: 'leo', name: 'LEO Token', current_price: 9.11, market_cap: 8381103623, price_change_percentage_24h_in_currency: -0.09863, price_change_percentage_7d_in_currency: -0.6296, price_change_percentage_30d_in_currency: 2.0452, price_change_percentage_1y_in_currency: -3.5993 },
    { id: 'tether-gold', symbol: 'xaut', name: 'Tether Gold', current_price: 3567.01, market_cap: 2885692392, price_change_percentage_24h_in_currency: 0.58937, price_change_percentage_7d_in_currency: -8.1924, price_change_percentage_30d_in_currency: -10.7396, price_change_percentage_1y_in_currency: -12.001 },
    { id: 'ethena-usde', symbol: 'usde', name: 'Ethena USDe', current_price: 0.999043, market_cap: 4851711241, price_change_percentage_24h_in_currency: 0.03685, price_change_percentage_7d_in_currency: -0.0638, price_change_percentage_30d_in_currency: -0.0435, price_change_percentage_1y_in_currency: 0.0483 },
    { id: 'nvidia-xstock', symbol: 'nvdax', name: 'NVIDIA xStock', current_price: 132.69, market_cap: 112797642, price_change_percentage_24h_in_currency: 1.1753, price_change_percentage_7d_in_currency: -18.8821, price_change_percentage_30d_in_currency: -36.3729, price_change_percentage_1y_in_currency: -25.2511 },
    { id: 'monero', symbol: 'xmr', name: 'Monero', current_price: 492.56, market_cap: 9277169300, price_change_percentage_24h_in_currency: 0.18731, price_change_percentage_7d_in_currency: -1.2477, price_change_percentage_30d_in_currency: -15.6731, price_change_percentage_1y_in_currency: 33.3374 },
    { id: 'aero', symbol: 'aero', name: 'Aero', current_price: 0.424235, market_cap: 326398749, price_change_percentage_24h_in_currency: 6.87816, price_change_percentage_7d_in_currency: -0.173, price_change_percentage_30d_in_currency: -41.8168, price_change_percentage_1y_in_currency: null },
    { id: 'aerodrome-finance', symbol: 'aero', name: 'Aerodrome Finance', current_price: 0.424062, market_cap: 100106448, price_change_percentage_24h_in_currency: 6.15977, price_change_percentage_7d_in_currency: -0.0052, price_change_percentage_30d_in_currency: -41.9682, price_change_percentage_1y_in_currency: -38.4666 },
    { id: 'lighter', symbol: 'lit', name: 'Lighter', current_price: 2.36, market_cap: 588924289, price_change_percentage_24h_in_currency: 1.21114, price_change_percentage_7d_in_currency: -16.7795, price_change_percentage_30d_in_currency: -25.0973, price_change_percentage_1y_in_currency: null },
  ],
  // Binance's product list (www.binance.com/bapi/.../get-products)
  products: [
    { s: 'BTCUSDT', st: 'TRADING', b: 'BTC', q: 'USDT', c: '61033.08', tags: ['Payments','mining-zone'] },
    { s: 'ETHUSDT', st: 'TRADING', b: 'ETH', q: 'USDT', c: '1714.55', tags: ['Layer1_Layer2','pos','mining-zone'] },
    { s: 'BNBUSDT', st: 'TRADING', b: 'BNB', q: 'USDT', c: '558.66', tags: ['Layer1_Layer2','pos','BSC'] },
    { s: 'XRPUSDT', st: 'TRADING', b: 'XRP', q: 'USDT', c: '0.9215', tags: ['Layer1_Layer2','Payments'] },
    { s: 'DOGEUSDT', st: 'TRADING', b: 'DOGE', q: 'USDT', c: '0.05497', tags: ['Meme','mining-zone'] },
    { s: 'USDCUSDT', st: 'TRADING', b: 'USDC', q: 'USDT', c: '1.00151', tags: ['stablecoin'] },
    { s: 'BNBBTC', st: 'TRADING', b: 'BNB', q: 'BTC', c: '0.009153', tags: ['Layer1_Layer2','pos','BSC'] },
    { s: 'AEROUSDT', st: 'TRADING', b: 'AERO', q: 'USDT', c: '0.4242', tags: ['defi'] },
  ],
  // Binance /api/v3/ticker/price
  prices: [
    { symbol: 'BNBBTC', price: '0.00915300' },
    { symbol: 'BTCUSDT', price: '61033.07000000' },
    { symbol: 'ETHUSDT', price: '1714.55000000' },
    { symbol: 'XMRUSDT', price: '118.70000000' },
    { symbol: 'LITUSDT', price: '0.74300000' },
  ],
};

// Nasdaq's names and countries for these companies' US listings (as lib/markets.mjs usCountries reads them).
const us = usCountries([
  { n: 'Apple Inc.' }, { n: 'ASML Holding N.V. New York Registry Shares', co: 'Netherlands' },
  { n: 'Banco Santander, S.A. Sponsored ADR', co: 'Spain' }, { n: 'Nokia Corporation Sponsored', co: 'Finland' },
  { n: 'BioNTech SE', co: 'Germany' }, { n: 'Toyota Motor Corporation', co: 'Japan' },
]);
const syms = (rows) => rows.map((r) => r.s);

await test('stocks: a market\'s own companies, largest first, with sectors and local market caps', () => {
  const sectors = new Map([['HSBA.L', 'Financial Services'], ['AZN.L', 'Healthcare'], ['SHEL.L', 'Energy']]);
  const rows = shapeStocks(REC.gb, 'GB', { us, sectors });
  // Out: Toyota (quoted in yen), Apple and Samsung (dollar lines), Santander (a Spanish company's
  // London line), the Schiehallion Fund, BP's preference shares (no market cap).
  assert.deepEqual(syms(rows), ['HSBA.L', 'AZN.L', 'SHEL.L', 'BP.L']);
  assert.deepEqual(rows.map((r) => r.sec), ['Financial Services', 'Healthcare', 'Energy', 'Other']);
  const hsbc = rows[0];
  assert.equal(hsbc.m, 210824462336); // pounds, as Yahoo gives London caps
  assert.equal(hsbc.p, 1234); // pence
  assert.ok(Number.isFinite(hsbc.c) && Number.isFinite(hsbc.y1));
  assert.deepEqual(marketCurrency('GB'), { cur: 'GBp', capCur: 'GBP' });
  assert.deepEqual(marketCurrency('JP'), { cur: 'JPY', capCur: 'JPY' });
  // Without the US list, a well-traded foreign line can't be told apart.
  assert.ok(syms(shapeStocks(REC.gb, 'GB')).includes('BNC.L'));
});

await test('stocks: foreign lines and spare share classes on Xetra are left out', () => {
  const rows = shapeStocks(REC.de, 'DE', { us });
  // Apple and ASML hardly trade in Frankfurt; Nokia is Finnish; Henkel keeps its more traded class.
  assert.deepEqual(syms(rows), ['SAP.DE', 'HEN3.DE', '22UA.DE']);
});

await test('stocks: Brazilian receipts of US stocks and real-estate funds are left out', () => {
  assert.deepEqual(syms(shapeStocks(REC.br, 'BR', { us })), ['PETR4.SA']);
});

await test('stocks: turnover counts London prices in pence', () => {
  const q = { marketCap: 1e9, regularMarketPrice: 200, averageDailyVolume3Month: 1e5 };
  assert.equal(turnover({ ...q, currency: 'EUR' }), 0.02);
  assert.equal(turnover({ ...q, currency: 'GBp' }), 0.0002);
  assert.equal(turnover({ ...q, marketCap: 0 }), 0);
  assert.equal(shapeStocks([], 'JP').length, 0);
  assert.equal(shapeStocks(null, 'JP').length, 0);
});

const coin = (id) => REC.coins.find((c) => c.id === id);
const before = (id) => REC.coins.slice(0, REC.coins.indexOf(coin(id)));

await test('crypto: stablecoins, wrapped and staked copies, tokenized stocks, funds and gold are pegged', () => {
  for (const id of ['tether', 'usd-coin', 'ethena-usde', 'tether-gold', 'nvidia-xstock', 'figure-heloc', 'wrapped-bitcoin', 'staked-ether', 'wrapped-steth']) {
    assert.ok(isPegged(coin(id), before(id)), `${id} should be left out`);
  }
  for (const id of ['bitcoin', 'ethereum', 'binancecoin', 'ripple', 'dogecoin', 'leo-token', 'monero', 'lighter']) {
    assert.ok(!isPegged(coin(id), before(id)), `${id} should stay`);
  }
  // Binance's own tags count too.
  assert.ok(isPegged({ id: 'x', symbol: 'abc', name: 'Abc', current_price: 3, price_change_percentage_24h_in_currency: 4 }, [], ['stablecoin']));
});

await test('crypto: Binance pairs (trading USDT pairs only) and plain prices', () => {
  const p = binanceProducts(REC.products);
  assert.ok(!p.has('BNBBTC') && p.size === REC.products.length - 1);
  assert.deepEqual(p.get('BTC'), { pair: 'BTCUSDT', price: 61033.08, tags: ['Payments', 'mining-zone'] });
  assert.equal(binanceProducts([{ ...REC.products[0], st: 'BREAK' }]).size, 0);
  const q = binancePrices(REC.prices);
  assert.deepEqual(q.get('ETH'), { pair: 'ETHUSDT', price: 1714.55, tags: null });
  assert.ok(!q.has('BNB'));
});

await test('crypto: rows by category, charts on Binance when its pair is the same coin', () => {
  const rows = shapeCoins(REC.coins, { pairs: binanceProducts(REC.products) });
  assert.deepEqual(syms(rows), ['BTC', 'ETH', 'BNB', 'XRP', 'DOGE', 'LEO', 'XMR', 'AERO', 'LIT']);
  const by = Object.fromEntries(rows.map((r) => [r.s, r]));
  assert.equal(by.BTC.full, 'BINANCE:BTCUSDT');
  assert.equal(by.XMR.full, 'YAHOO:XMR-USD'); // not on Binance
  assert.deepEqual(rows.map((r) => r.sec), ['Payments', 'Layer 1 & 2', 'Exchange tokens', 'Payments', 'Meme', 'Exchange tokens', 'Payments', 'DeFi', 'Other']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const btc = coin('bitcoin');
  assert.equal(by.BTC.m, btc.market_cap);
  assert.equal(by.BTC.c, Math.round(btc.price_change_percentage_24h_in_currency * 100) / 100);
  assert.equal(by.BTC.r1w, Math.round(btc.price_change_percentage_7d_in_currency * 100) / 100);
  assert.equal(by.BTC.r1m, Math.round(btc.price_change_percentage_30d_in_currency * 100) / 100);
  assert.equal(by.BTC.y1, Math.round(btc.price_change_percentage_1y_in_currency * 100) / 100);
  assert.equal(by.BTC.r3m, null); // filled in from daily candles later
});

await test('crypto: without Binance\'s tags, rank tiers; a ticker with another coin\'s price isn\'t its chart', () => {
  const rows = shapeCoins(REC.coins, { pairs: binancePrices(REC.prices) });
  assert.ok(rows.every((r) => r.sec === 'Top 10'));
  const by = Object.fromEntries(rows.map((r) => [r.s, r]));
  assert.equal(by.ETH.full, 'BINANCE:ETHUSDT');
  assert.equal(by.LIT.full, 'YAHOO:LIT-USD'); // Binance's LIT is Litentry, not Lighter
  assert.equal(by.XMR.full, 'YAHOO:XMR-USD'); // delisted from Binance: its old price is stale
  // Binance unreachable: every chart on Yahoo.
  assert.ok(shapeCoins(REC.coins).every((r) => r.full.startsWith('YAHOO:')));
  assert.deepEqual(shapeCoins([]), []);
});

await test('crypto: categories, tiers and changes', () => {
  assert.equal(coinCategory('binancecoin', ['Layer1_Layer2']), 'Exchange tokens');
  assert.equal(coinCategory('kaspa', null), 'Layer 1 & 2');
  assert.equal(coinCategory('x', ['Meme', 'Layer1_Layer2']), 'Meme');
  assert.equal(coinCategory('x', ['AI', 'RWA', 'defi']), 'DeFi');
  assert.equal(coinCategory('x', []), 'Other');
  assert.deepEqual([1, 10, 11, 25, 26, 50, 51, 100, 101].map(rankTier), ['Top 10', 'Top 10', '11–25', '11–25', '26–50', '26–50', '51–100', '51–100', '101+']);
  assert.equal(changeOver([100, null, 90, 120]), 20);
  assert.equal(changeOver([5]), null);
  assert.equal(changeOver(null), null);
});

await test('panel: every market the server knows, sizes that fit, periods it can colour', () => {
  assert.deepEqual(MARKETS.map(([k]) => k).filter((k) => k !== 'us').sort(), Object.keys(HEATMAP_MARKETS).sort());
  assert.equal(pickSize(sizesFor('us'), 500), 500);
  assert.equal(pickSize(sizesFor('crypto'), 1000), 250);
  assert.equal(pickSize(sizesFor('crypto'), 10), 50);
  assert.equal(pickSize(sizesFor('JP'), 300), 250);
  const rows = [{ c: 1, r1w: null, y1: 5 }, { c: -1, r1w: null, y1: null }];
  assert.deepEqual([...periodsAvailable({ rows, tech: { done: 2, total: 2 } })], ['c', 'y1']);
  assert.deepEqual([...periodsAvailable({ rows, tech: { done: 0, total: 2 } })], ['c', 'r1w', 'r1m', 'r3m', 'y1']);
  assert.equal(periodsAvailable(null).size, 5);
});

await test('panel: prices and market caps in the market\'s currency', () => {
  assert.equal(money(61066), '$61,066.00');
  assert.equal(money(0.00000358), '$0.00000358');
  assert.equal(money(1234.5, 'GBp'), '1,234.5p');
  assert.equal(money(210.8e9, 'GBP', true), '£211B');
  assert.equal(money(3329, 'JPY'), '¥3,329');
  assert.equal(money(3.1e12, 'USD', true), '$3.1T');
  assert.equal(money(4.2e12, 'INR', true), '₹4.2T');
  assert.equal(money(null, 'EUR'), '—');
});

await test('server: /api/heatmap wants a known market', async () => {
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    for (const q of ['', '?market=nope', '?market=__proto__', '?market=us']) {
      const r = await fetch(`http://127.0.0.1:${port}/api/heatmap${q}`);
      assert.equal(r.status, 400, q);
      assert.match((await r.json()).error, /Unknown market/);
    }
  } finally { server.close(); }
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
