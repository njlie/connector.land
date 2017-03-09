var fs = require('fs');
var ping = require('ping');
var https = require('https');
var WebFinger = require('webfinger.js').WebFinger;
var wf = new WebFinger();
var msgToSelf = require('./msgToSelf');
var hostsArr = require('../data/hosts.js').hosts;
var request = require('request');

//TODO: get this from list of ledgers on which msgToSelf works:
var destinations = [
  'lu.eur.michiel.',
  'us.usd.hexdivision.',
  'eu.eur.pineapplesheep.',
  'us.usd.michiel-is-not-available.',
  'lu.eur.michiel-eur.',
  'us.usd.cygnus.',
  'us.usd.nexus.',
  'us.usd.cornelius.',
//  'us.usd.usd.', only connected to mmk?
  'us.usd.best-ilp.',
  'us.usd.ggizi.',
//  'ca.usd.royalcrypto.', old ilp-kit version?
  'de.eur.blue.',
  'us.usd.red.',
//  'mm.mmk.interledger.', only connected to us.usd.usd?
//  'kr.krw.interledgerkorea.', old ilp-kit version?
];

const RAW_FILE = '../data/stats-raw.json';
const OUTPUT_FILE = '../data/stats.json';

var rateCache;
var ledgerCurrency = {};
var connectorLedger = {};

function getCurrencyRates() {
  if (typeof rateCache === 'object') {
    return Promise.resolve(rateCache);
  }
  return new Promise(resolve => {
    request({
      method: 'get',
      uri: 'https://api.fixer.io/latest',
      json: true,
    }, (err, sendRes, body) => {
      if (typeof body === 'object' && typeof body.rates === 'object') {
        body.rates.EUR = 1.0000;
        resolve(body.rates);
      } else {
        resolve({
          EUR: 1.0000,
          AUD: 1.3968,
          BGN: 1.9558,
          BRL: 3.3151,
          CAD: 1.4193,
          CHF: 1.0702,
          CNY: 7.2953,
          CZK: 27.021,
          DKK: 7.4335,
          GBP: 0.86753,
          HKD: 8.1982,
          HRK: 7.4213,
          HUF: 310.7,
          IDR: 14145,
          ILS: 3.8879,
          INR: 70.496,
          JPY: 120.65,
          KRW: 1216.4,
          MXN: 20.713,
          MYR: 4.7082,
          NOK: 8.9513,
          NZD: 1.5219,
          PHP: 53.198,
          PLN: 4.313,
          RON: 4.5503,
          RUB: 61.757,
          SEK: 9.5223,
          SGD: 1.4947,
          THB: 37.236,
          TRY: 3.9434,
          USD: 1.0556,
          ZAR: 13.791,
        });
      }
    });
  }).then(rates => {
    rateCache = rates;
    return rates;
  });
}

function prefixToCurrency(prefix) {
  var parts = prefix.split('.');
  var str = '';
  for (var i=0; i<parts.length; i++) {
    str += parts[i] + '.';
    if (ledgerCurrency[str]) {
      return ledgerCurrency[str];
    }
  }
  console.warn('WARNING! Currency not found for prefix', prefix);
  return 'EUR';
}

function exchangeRate(fromConn, toLedger) {
  if (typeof rateCache !== 'object') {
    console.warn('WARNING! Rate cache empty');
    return 'EUR';
  }
  var from = prefixToCurrency(fromConn);
  var to = prefixToCurrency(toLedger);
  // if from === EUR and to === USD, this returns:
  //              1.0000 / 1.0556
  // so it's the expected source amount if fee is zero.
  console.log('exchangeRate', fromConn, toLedger, from, to, rateCache[from], rateCache[to], rateCache[from] / rateCache[to]);
  return rateCache[from] / rateCache[to];
}

function checkUrl(i, path) {
  return new Promise((resolve) => {
    var request = https.request({
      hostname: hostsArr[i].hostname,
      port:443,
      path: path,
      method: 'GET'
    }, function(response) {
      var str = '';
      response.on('data', function (chunk) {
        str += chunk;
      });

      response.on('end', function () {
        resolve({ status: response.statusCode, body: str });
      });
    });
    request.setTimeout(5000, function(err) {
      resolve({ error: 'Timed out' });
    });
    request.on('error', function(err) {
      resolve({ error: 'Connection error' });
    });
    request.end();
  });
}

function checkApiCall(i, field, path, print) {
  return checkUrl(i, path).then((result) => {
    if (result.error) {
        return `<span style="color:red">${result.error}</span>`;
    } else if (result.status === 200) {
      return print(result.body);
    } else {
      return `HTTP <span style="color:red">${result.status}</span> response`;
    }
  }).then(text => {
    hostsArr[i][field] = text;
  });
}

function checkHealth(i) {
  return checkApiCall(i, 'health', '/api/health', function(body) {
    return body;
  });
}

function getApiVersion(i) {
  return new Promise((resolve) => {
    wf.lookup('https://'+hostsArr[i].hostname, function(err, result) {
      if (err) {
        resolve(`<span style="color:red">WebFinger error</span>`);
        return;
      }
      var version
      try {
        version = result.object.properties['https://interledger.org/rel/protocolVersion'];
      } catch(e) {
        resolve(`<span style="color:red">WebFinger properties missing</span>`);
        return;
      }
      if (typeof version === 'string') {
        resolve(`<span style="color:green">${version}</span>`);
      } else {
        resolve(JSON.stringify(version));
      }
    });
  }).then(text => {
    hostsArr[i].version = text;
  });
}

function checkSettlements(i) {
  return checkApiCall(i, 'settlements', '/api/settlement_methods', function(body) {
    var methods
    try {
      methods = JSON.parse(body);
      if (methods.length === 0) {
        return 'None';
      }
      return '<span style="color:green">' +
        methods.map(obj => obj.name).join(', ') +
        '</span>';
    } catch(e) {
      return '<span style="color:red">Unparseable JSON</span>';
    }
  });
}

function printScale(s) {
  const scales = {
    1: 'deci',
    2: 'centi',
    3: 'milli',
    6: 'micro',
    9: 'nano',
  };
  if (scales[s]) {
    return scales[s];
  }
  return `(10^-${s})`;
}

var extraConnectors = {}; // per DNS host, list accounts, only the extra ones
var connectors = {}; // per ILP address, list messaging delay, extra ones as well as defaults
var named = require('../data/hosts.js').named;
for (var i=0; i<named.length; i++) {
  for (var j=0; j<named[i].addresses.length; j++) {
    var parts = named[i].addresses[j].split('@');
    if (typeof extraConnectors[parts[1]] === 'undefined') {
      extraConnectors[parts[1]] = [];
    } 
    extraConnectors[parts[1]].push(parts[0]);
  }
}

function checkLedger(i) {
  return checkUrl(i, '/ledger').then(result => {
    if (result.error) {
        hostsArr[i].maxBalance = `<span style="color:red">?</span>`;
        hostsArr[i].prefix = `<span style="color:red">?</span>`;
        return;
    }
    if (result.status === 200) {
      var data;
      try {
        data = JSON.parse(result.body);
      } catch(e) {
        hostsArr[i].maxBalance = `<span style="color:red">?</span>`;
        hostsArr[i].prefix = `<span style="color:red">?</span>`;
        return;
      }

      ledgerCurrency[data.ilp_prefix] = data.currency_code;

      hostsArr[i].prefix = data.ilp_prefix;
      hostsArr[i].maxBalance = `10^${data.precision} ${printScale(data.scale)}-${data.currency_code}`;
      var recipients = (extraConnectors[hostsArr[i].hostname] || []).concat(data.connectors.map(obj =>  obj.name));
      recipients.map(name => {
        connectorLedger[hostsArr[i].prefix + name] = hostsArr[i].prefix;
      });
      recipients.push('connectorland');

      return msgToSelf.test(hostsArr[i].hostname, hostsArr[i].prefix, recipients, destinations).then(result => {
        // {
        //   connectSuccess: true,
        //   connectTime: 4255,
        //   sendResults: {
        //     'kr.krw.interledgerkorea.connector': 'could not send',
        //     'kr.krw.interledgerkorea.connectorland': 987,
        //   },
        //   quoteResults: {
        //     'kr.krw.interledgerkorea.': 'no data',
        //   ,}
        // }
console.log('results are in:', hostsArr[i].hostname, hostsArr[i].prefix, recipients, destinations, result); 
        hostsArr[i].messaging = (result.connectSuccess ? result.connectTime : 'fail');
        hostsArr[i].messageToSelf = result.sendResults[hostsArr[i].prefix + 'connectorland'];
        for (var addr in result.sendResults) {
          if (addr !== hostsArr[i].prefix + 'connectorland') {
            connectors[addr] = {
              sendResults: result.sendResults[addr],
              quoteResults: result.quoteResults[addr],
            };
          }
        }
      }, err => {
        hostsArr[i].messaging = 'no data';
      });
    }
  }).then(() => {
  });
}

function pingHost(i) {
  return new Promise((resolve) => {
    ping.sys.probe(hostsArr[i].hostname, function(isAlive){
      hostsArr[i].ping = isAlive;
      resolve();
    });
  });
}

function mergeHost(existingData, newData) {
// "red.ilpdemo.org": {
//      "hostname": "red.ilpdemo.org",
//      "owner": "",
//      "prefix": "us.usd.red.",
//      "maxBalance": "10^10 centi-USD",
//      "version": "<span style=\"color:green\">Compatible: ilp-kit v1.1.0</span>",
//      "health": "OK",
//      "settlements": "<span style=\"color:green\"></span>",
//      "ping": false,
//      "messaging": 3228,
//      "messageToSelf": 504
//    },
  // convert booleans to numbers
  newData.health = (newData.health === 'OK' ? 1 : 0);
  newData.ping = (newData.ping ? 1 : 0);


  if (typeof existingData === 'object') {
    ['health', 'ping'].map(field => {
      if (typeof existingData[field] === 'number') {
        newData[field] = newData[field] * .01 + .99 * existingData[field];
      }
    });
  }
  // filter out fields we want to track for hosts:
  var filteredData = {};
  ['hostname', 'owner', 'prefix', 'version', 'health', 'settlements', 'ping'].map(field => {
    filteredData[field] = newData[field];
  });
  return filteredData;
}

function mergeLedger(existingData, newData) {
  if (typeof existingData === 'object') {
    ['messaging', 'messageToSelf'].map(field => {
      if (typeof existingData[field] === 'number') {
        newData[field] = newData[field] * .01 + .99 * existingData[field];
      }
    });
  }
  // filter out fields we want to track for ledgers:
  var filteredData = {};
  ['hostname', 'prefix', 'maxBalance', 'messaging', 'messageToSelf'].map(field => {
    filteredData[field] = newData[field];
  });
  return filteredData;
}

function mergeConnector(existingData, newData, ledger) {
  //   "us.usd.jonhvb.connector": 131,
  //  "lu.eur.michiel-eur.micmic": "could not send",
  // "ca.usd.royalcrypto.micmic": "no reply",

  var newObj;
  if (typeof newData.sendResults === 'number') {
    newObj = {
      ledger,
      couldSend: 1,
      gotReply: 1,
      delay: newData.sendResults,
      quoteResults: newData.quoteResults,
    };
  } else if (newData.sendResults === 'no reply') {
    newObj = {
      ledger,
      couldSend: 1,
      gotReply: 0,
      delay: 5000,
      // quoteResults: undefined,
    };
  } else {
    newObj = {
      ledger,
      couldSend: 0,
      gotReply: 0,
      delay: 5000,
      // quoteResults: undefined,
    };
  }
  if (typeof existingData === 'object') {
    ['couldSend', 'gotReply', 'delay'].map(field => {
      if (typeof existingData[field] === 'number') {
        newObj[field] = .01 * newObj[field] + .99 * existingData[field];
      }
    });
  } 
  // note that unlike couldSend, gotReply, and delay,
  // quoteResults are always just the latest data, not a rolling average.
  return newObj;
}

function integer(num) {
  return Math.floor(num + .5);
}

function percentage(num) {
  const DIGITS_FACTOR = 1000;
  var numDigits = integer(num * 100 * DIGITS_FACTOR);
  return `${numDigits / DIGITS_FACTOR}%`;
}

function fee(price, baseValue) {
  if (typeof price !== 'number') {
    return price;
  }
  var paidExtra = price - baseValue;
console.log('fee', price, baseValue, percentage(paidExtra / baseValue));
  return percentage(paidExtra / baseValue);
}

// ...
var promises = [ getCurrencyRates() ]; // needed before displaying connector fees
//for (var i=16; i<17; i++) {
for (var i=0; i<hostsArr.length; i++) {
  promises.push(getApiVersion(i));
  promises.push(pingHost(i));
  promises.push(checkHealth(i));
  promises.push(checkSettlements(i));
  promises.push(checkLedger(i));
//  if (typeof perfStats[hostsArr[i].hostname] !== 'undefined') {
//    hostsArr[i].speed = perfStats[hostsArr[i].hostname].speed // needed before displaying connector fees;
//    hostsArr[i].price = perfStats[hostsArr[i].hostname].price;
//    hostsArr[i].reliability = perfStats[hostsArr[i].hostname].reliability;
//  } else {
//    hostsArr[i].speed = 0;
//    hostsArr[i].price = 0;
//    hostsArr[i].reliability = 0;
//  } 
}
Promise.all(promises).then(() => {
  var stats = {
    hosts: {},
    ledgers: {},
    connectors: {},
  };
  try {
   stats = JSON.parse(fs.readFileSync(RAW_FILE));
  } catch(e) {
  }
  for (var i=0; i < hostsArr.length; i++) {
    stats.hosts[hostsArr[i].hostname] = mergeHost(stats.hosts[hostsArr[i].hostname], hostsArr[i]);
  }
  for (var i=0; i < hostsArr.length; i++) {
    stats.ledgers[hostsArr[i].hostname] = mergeLedger(stats.ledgers[hostsArr[i].hostname], hostsArr[i]);
  }
  for (var i in connectors) {
    if (typeof connectorLedger[i] !== 'string') {
      console.log(connectorLedger, i, 'not found!');
      process.exit(1);
    }
    stats.connectors[i] = mergeConnector(stats.connectors[i], connectors[i], connectorLedger[i]);
  }
  fs.writeFileSync(RAW_FILE, JSON.stringify(stats, null, 2));

  var hostRows = Object.keys(stats.hosts).sort(function(keyA, keyB) {
    var a = stats.hosts[keyA];
    var b = stats.hosts[keyB];
    var delayA = (typeof a.messaging === 'number' ? a.messaging : 1000000);
    var delayB = (typeof b.messaging === 'number' ? b.messaging : 1000000);
    if (delayA < delayB) { return -1; }
    if (delayA > delayB) { return 1; }
    if ((typeof a.messaging === 'number') && (typeof b.messaging !== 'number')) { return -1; }
    if ((typeof a.messaging !== 'number') && (typeof b.messaging === 'number')) { return 1; }
    if ((('' + a.settlements).indexOf('<span style="color:red">') !== -1) && (('' + b.settlements).indexOf('<span style="color:red">') === -1)) { return 1; }
    if ((('' + a.settlements).indexOf('<span style="color:red">') === -1) && (('' + b.settlements).indexOf('<span style="color:red">') !== -1)) { return -1; }
//    if (a.reliability < b.reliability) { return 1; }
//    if (a.reliability > b.reliability) { return -1; }
//    if (a.speed < b.speed) { return -1; }
//    if (a.speed > b.speed) { return 1; }
//    if (a.price < b.price) { return -1; }
//    if (a.price > b.price) { return 1; }
    if ((a.health === 'OK') && (b.health !== 'OK')) { return -1; }
    if ((a.health !== 'OK') && (b.health === 'OK')) { return 1; }
    if ((a.ping) && (!b.ping)) { return -1; }
    if ((!a.ping) && (b.ping)) { return 1; }
    if ((a.settlements === 'None') && (b.settlements !== 'None')) { return 1; }
    if ((a.settlements !== 'None') && (b.settlements === 'None')) { return -1; }
    if (a.hostname < b.hostname) { return -1; }
    if (a.hostname > b.hostname) { return 1; }
    return 0;
  }).map(key => stats.hosts[key]);
  var str = JSON.stringify({
    headers: [
    '<th>ILP Kit URL</th>',
//     '<th>Reliability (success rate)</th>',
//     '<th>Speed (one transaction)</th>',
//     '<th>Price (commission fee on a 0.01 EUR/USD transaction)</th>',
    '<th>ILP Kit Version</th>',
    '<th>Ledger Prefix</th>',
    '<th>Max Balance</th>',
    '<th>Message Delay</th>',
    '<th>Owner\'s Connector Account</th>',
    '<th>Settlement Methods</th>',
    '<th>Health</th>',
    '<th>Ping</th>',
  ],
    rows: hostRows.map(line =>
    `<tr><td><a href="https://${line.hostname}">${line.hostname}</a></td>` +
//        `<td>${Math.floor(1000*line.reliability)/10}%</td>` +
//        `<td>${Math.floor(line.speed)/1000} seconds</td>` +
//        `<td>${Math.floor(100*line.price)}%</td>` +
        `<td>${line.version}</td>` +
        `<td>${line.prefix}</td>` +
        `<td>${stats.ledgers[line.hostname].maxBalance}</td>` +
        `<td>${stats.ledgers[line.hostname].messaging}</td>` +
        `<td>${line.owner}</td>` +
        `<td>${line.settlements.slice(0, 50)}</td>` +
        `<td>${percentage(line.health)}</td>` +
        `<td>${percentage(line.ping)}</td>` +
        `</tr>`
  ),

    hosts: {
      headers: [
        '<th>ILP Kit URL</th>',
        '<th>ILP Kit Version</th>',
        '<th>Owner\'s Connector Account</th>',
        '<th>Settlement Methods</th>',
        '<th>Health</th>',
        '<th>Ping</th>',
        '<th>Ledger</th>',
        '<th>Real Money?</th>',
      ],
      rows: hostRows.map(line =>
        `<tr><td><a href="https://${line.hostname}">${line.hostname}</a></td>` +
        `<td>${line.version}</td>` +
        `<td>${line.owner}</td>` +
        `<td>${line.settlements.slice(0, 50)}</td>` +
        `<td>${percentage(line.health)}</td>` +
        `<td>${percentage(line.ping)}</td>` +
        (typeof stats.ledgers[line.hostname].messaging === 'number' ? `<td>${line.prefix}</td>` : `<td><strike style="color:red">${line.prefix}</strike></td>`) +
        `<td>${(typeof line.prefix === 'string' && line.prefix.substring(0,2) === 'g.' ? 'YES' : 'NO')}</td>` +
        `</tr>`
      ),
    },
    ledgers: {
      headers: [
        '<th>Ledger Prefix</th>',
        '<th>Max Balance</th>',
        '<th>Message Delay</th>',
        '<th>Host</th>',
      ],
      rows: Object.keys(stats.ledgers).map(hostname => {
        var line = stats.ledgers[hostname];
        return (typeof line.messaging === 'number' ?
          `<tr><td>${line.prefix}</td>` +
          `<td>${line.maxBalance}</td>` +
          `<td>${integer(line.messaging)}</td>` +
          `<td><a href="https://${line.hostname}">${line.hostname}</a></td>` +
          `</tr>`
        : '');
      }),
    },
    connectors: {
      headers: [ `<th>ILP address</th><th>Quote Delay (ms)</th>`,
          //`<th colspan="${destinations.length}">Micropayment fee to:</th>`,
          //`</tr><tr>`, // cheating, to get a second headers row
          //`<th></th><th></th>` //leave two columns empty on second headers row
        ].concat(destinations.map(dest => `<th style="white-space:pre">${dest}\n(fee for sending one cent)</th>`)),
      rows: Object.keys(stats.connectors).sort((a, b) => {
        return stats.connectors[a].delay - stats.connectors[b].delay;
      }).map(addr => {
        return `<tr><td>${addr}</td><td>${integer(stats.connectors[addr].delay)}</td>` +
          (typeof stats.connectors[addr].quoteResults === 'undefined' ?
            '' :
            destinations.map(dest => `<td>${fee(stats.connectors[addr].quoteResults[dest], 0.01 * exchangeRate(addr, dest))}</td>`)
          ) +
          '</tr>';
      }),
    },
  }, null, 2);
  fs.writeFileSync(OUTPUT_FILE, str);
  process.exit(0);
}, err => {
  console.log(err);
});
