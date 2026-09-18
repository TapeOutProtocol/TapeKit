// 生成本地部署页：持有人在浏览器钱包里签名，把 DeWEB 跨链消息层的中枢通过确定性部署器（CREATE2）部署到各条链。
// 本脚本和生成的页面都不接触私钥；页面只调用 window.ethereum。
//
//   forge build && node script/deploy-page.mjs
//   → dist/deploy-deweb-hub.html（用浏览器打开）
//
// 每条链：
//   1) 启动实现 DeWebBoot（没有构造参数，各链地址相同）
//   2) 代理（地址只取决于启动实现和 owner = 连接的钱包，各链相同），部署时 initialize(owner)
//   3) 该链的正式实现 DeWebHub（需要该链上的 TapeOut 电路协议地址）
//   4) owner 把代理升级到正式实现
// 目前只有 BNB Smart Chain 部署了 TapeOut 电路协议，其他链只能做 1、2 两步（中枢停在启动状态，收发不了消息）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, getCreate2Address, AbiCoder, toUtf8Bytes, getAddress } from 'ethers';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
// 写死预期的 owner 与中枢地址：连错钱包时整页拒绝操作，保证各链地址一致（审计 M3）
const EXPECTED_OWNER = '0x571d447f4f24688eC35Ccf07f1D6993655F6aF15';
const EXPECTED_HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee';

// 各链的 TapeOut 电路协议地址。没有的链为 null：只能部署启动实现和代理。
const CHAINS = {
  56: {
    name: 'BNB Smart Chain', short: 'bnb', hex: '0x38', currency: 'BNB',
    rpc: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com',
    tapeout: {
      registry: '0x000000006551c19487814612e58FE06813775758',
      implementation: '0xAf4E78a2257C9c5480c2F8310E3b00437260751d',
      factory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',
      payments: '0xc0C643eb9820eF208Ea38bb2c8E8377047D9fa4c',
      circuitBeacon: '0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156',
      circuitImplementation: '0x8E1D125Def6d3826C278299273a0760D47626068',
      circuitCodehash: '0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992',
    },
  },
  8453: {
    name: 'Base', short: 'base', hex: '0x2105', currency: 'ETH',
    rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', tapeout: null,
  },
  196: {
    name: 'X Layer', short: 'xlayer', hex: '0xc4', currency: 'OKB',
    rpc: 'https://rpc.xlayer.tech', explorer: 'https://www.oklink.com/xlayer', tapeout: null,
  },
};

const readCreation = (name) => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, `out/${name}.sol/${name}.json`), 'utf8'));
  const code = artifact.bytecode.object;
  if (!/^0x[0-9a-f]+$/i.test(code)) throw new Error(`missing creation bytecode for ${name}; run forge build first`);
  return code;
};

const bootCreation = readCreation('DeWebBoot');
const proxyCreation = readCreation('DeWebProxy');
const hubCreation = readCreation('DeWebHub');

const SALT_BOOT = keccak256(toUtf8Bytes('DeWEB Boot v1'));
const SALT_PROXY = keccak256(toUtf8Bytes('DeWEB Hub v1'));
const SALT_HUB_IMPL = keccak256(toUtf8Bytes('DeWEB Hub impl v2'));

const bootAddress = getCreate2Address(DEPLOYER, SALT_BOOT, keccak256(bootCreation));

const chainData = {};
for (const [id, c] of Object.entries(CHAINS)) {
  let impl = null;
  if (c.tapeout) {
    const t = c.tapeout;
    const args = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'address', 'address', 'address', 'address', 'address', 'bytes32'],
      [Number(id), t.registry, t.implementation, t.factory, t.payments, t.circuitBeacon, t.circuitImplementation, t.circuitCodehash],
    );
    const initCode = hubCreation + args.slice(2);
    impl = {
      address: getCreate2Address(DEPLOYER, SALT_HUB_IMPL, keccak256(initCode)),
      initCodeHash: keccak256(initCode),
      txData: SALT_HUB_IMPL + initCode.slice(2),
      expect: t,
    };
  }
  chainData[id] = { name: c.name, short: c.short, hex: c.hex, currency: c.currency, rpc: c.rpc, explorer: c.explorer, impl };
}

// 页面里要自己算代理的 CREATE2 地址（initCode 含 owner），把 keccak256 打包进去
const keccakBundle = (await build({
  stdin: {
    contents: "import { keccak_256 } from '@noble/hashes/sha3.js';\nwindow.keccak256Hex = (hex) => { const b = hex.replace(/^0x/, ''); const u = new Uint8Array(b.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(b.slice(i * 2, i * 2 + 2), 16); return '0x' + [...keccak_256(u)].map((x) => x.toString(16).padStart(2, '0')).join(''); };\n",
    resolveDir: path.join(root, '..', 'module'),
  },
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
})).outputFiles[0].text;

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const implRows = Object.entries(chainData).map(([id, c]) => `<tr><td>${esc(c.name)}（${id}）正式实现</td><td class="mono">${c.impl ? esc(c.impl.address) : '— 该链还没有 TapeOut 电路协议'}</td></tr>`).join('\n');

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>部署 DeWEB 中枢</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:860px;margin:40px auto;padding:0 16px;color:#111}
code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #eee;padding:6px 4px;vertical-align:top}
button{font-size:16px;padding:10px 18px;margin:6px 8px 6px 0}
select{font-size:16px;padding:8px}
#log{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px;min-height:3em}
.ok{color:#0a7a2f}.bad{color:#b3261e}.warn{background:#fff6e5;border-left:4px solid #d08700;padding:10px 14px;margin:16px 0}
.note{background:#eef4ff;border-left:4px solid #3b6fd6;padding:10px 14px;margin:16px 0}
h2{margin-top:32px;font-size:18px}
</style></head><body>
<h1>部署 DeWEB 跨链消息层 · 中枢</h1>
<p>这一页由你的钱包签名，把 DeWEB 中枢部署到选定的链上。<b>连接的这个钱包会成为中枢的 owner</b>；同一个 owner 在每条链上得到<b>同一个中枢地址</b>。</p>

<div class="warn"><b>可升级期间的风险：</b>封印（seal）之前，owner 可以更换实现合约，也就能改写身份核对逻辑，冒充任何电路容器发消息、改写任何公钥记录。每条链各自封印。</div>

<h2>固定参数</h2>
<table>
<tr><td>确定性部署器</td><td class="mono">${DEPLOYER}</td></tr>
<tr><td>启动实现（各链相同）</td><td class="mono">${bootAddress}</td></tr>
<tr><td>启动实现 salt</td><td class="mono">${SALT_BOOT}</td></tr>
<tr><td>代理 salt</td><td class="mono">${SALT_PROXY}</td></tr>
<tr><td>正式实现 salt</td><td class="mono">${SALT_HUB_IMPL}</td></tr>
${implRows}
<tr><td>预期 owner（只能用这个钱包操作）</td><td class="mono">${EXPECTED_OWNER}</td></tr>
<tr><td>预期中枢地址（各链相同）</td><td class="mono">${EXPECTED_HUB}</td></tr>
<tr><td>按连接的钱包算出的中枢地址</td><td class="mono" id="hubAddr">—</td></tr>
</table>
<div class="warn"><b>封印的前提：</b>中枢钉住了 TapeOut 电路合约的实现。封印之后如果电路合约再被升级，这条链的中枢会永久停用。所以本页只在该链的 TapeOut 工厂<b>已经封印</b>之后才允许封印中枢。</div>
<p>核对方法：在源码目录运行 <code>forge build &amp;&amp; OWNER=你的地址 forge script script/Deploy.s.sol --fork-url bsc</code>，打印出的地址必须与本页一致。</p>

<h2>选择链</h2>
<select id="chain">${Object.entries(chainData).map(([id, c]) => `<option value="${id}">${esc(c.name)}（chainId ${id}）</option>`).join('')}</select>
<div id="chainNote" class="note"></div>

<h2>部署</h2>
<button id="connect">1. 连接钱包并切换到这条链</button><br>
<button id="deployBoot" disabled>2. 部署启动实现</button>
<button id="deployProxy" disabled>3. 部署中枢（代理）</button><br>
<button id="deployImpl" disabled>4. 部署本链正式实现</button>
<button id="upgrade" disabled>5. 中枢切换到正式实现</button><br>
<button id="verify">6. 核对链上结果</button>

<h2>封印（以后再做）</h2>
<p>确认逻辑不再需要改动后再执行。<b>不可撤销</b>：owner 被置零，升级入口永久关闭。只封印当前选中的这条链。</p>
<button id="seal" disabled>封印这条链的中枢</button>

<div id="log"></div>
<script>${keccakBundle}</script>
<script>
const DEPLOYER=${JSON.stringify(DEPLOYER)};
const EXPECTED_OWNER=${JSON.stringify(EXPECTED_OWNER)}.toLowerCase();
const EXPECTED_HUB=${JSON.stringify(EXPECTED_HUB)}.toLowerCase();
const BOOT=${JSON.stringify(bootAddress)};
const BOOT_DATA=${JSON.stringify(SALT_BOOT + bootCreation.slice(2))};
const PROXY_SALT=${JSON.stringify(SALT_PROXY)};
const PROXY_CREATION=${JSON.stringify(proxyCreation)};
const CHAINS=${JSON.stringify(chainData)};
const FACTORY_IMPL={56:'0xa68ccf4931d98ad0a4be15ee40542edc0dec6422'};
const SEL={registry:'0x7b103999',accountImplementation:'0x11464fbe',factory:'0xc45a0155',payments:'0xa6d23e10',circuitBeacon:'0xddcb22fa',circuitImplementation:'0x14f96a60'};
const IMPL_SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const $=(id)=>document.getElementById(id);
const log=(m,c)=>{const d=document.createElement('div');d.textContent=m;if(c)d.className=c;$('log').appendChild(d)};
const pad=(h)=>h.replace(/^0x/,'').toLowerCase().padStart(64,'0');
const has=(code)=>!!(code&&code!=='0x');
let account=null, hubAddress=null;
const chainId=()=>$('chain').value;
const cfg=()=>CHAINS[chainId()];

function showNote(){
  const c=cfg();
  $('chainNote').textContent=c.impl
    ? c.name+' 上已有 TapeOut 电路协议：可以完成全部 5 步，部署后就能收发消息。gas 用 '+c.currency+' 支付。'
    : c.name+' 上还没有 TapeOut 电路协议：只能做第 2、3 步，中枢会停在「启动状态」，这条链上暂时收发不了消息。等 TapeOut 电路协议部署到这条链之后，再做第 4、5 步。gas 用 '+c.currency+' 支付。';
  for(const b of ['deployBoot','deployProxy','deployImpl','upgrade','seal'])$(b).disabled=true;
  if(account)void refresh();
}
$('chain').onchange=showNote;
if(window.ethereum&&window.ethereum.on){
  // 钱包里换了账户或网络：清掉已连接状态，必须重新点第 1 步
  window.ethereum.on('accountsChanged',()=>{account=null;hubAddress=null;$('hubAddr').textContent='—';log('钱包账户已变更，请重新点第 1 步。','bad');for(const b of ['deployBoot','deployProxy','deployImpl','upgrade','seal'])$(b).disabled=true;});
  window.ethereum.on('chainChanged',()=>{if(account)log('钱包网络已变更，请重新点第 1 步。','bad');for(const b of ['deployBoot','deployProxy','deployImpl','upgrade','seal'])$(b).disabled=true;});
}
showNote();

// 代理 initCode = creationCode ‖ abi.encode(启动实现, initialize(owner) 的调用数据)
function proxyInitCode(owner){
  const initCall='c4d66de8'+pad(owner);
  const head=pad(BOOT)+pad('40')+pad((initCall.length/2).toString(16))+initCall.padEnd(Math.ceil(initCall.length/64)*64,'0');
  return PROXY_CREATION+head.replace(/^0x/,'');
}
function create2(salt,initCode){
  const h=window.keccak256Hex(initCode);
  return '0x'+window.keccak256Hex('0xff'+DEPLOYER.slice(2)+salt.slice(2)+h.slice(2)).slice(-40);
}
async function rpc(method,params=[]){return window.ethereum.request({method,params})}
async function onChain(){
  const id=await rpc('eth_chainId');
  if(parseInt(id,16)!==Number(chainId())){log('钱包当前不在 '+cfg().name+'，请点第 1 步切换。','bad');return false}
  return true;
}
async function switchChain(){
  const c=cfg();
  try{await rpc('wallet_switchEthereumChain',[{chainId:c.hex}])}
  catch(e){
    const code=e&&(e.code??(e.data&&e.data.originalError&&e.data.originalError.code));
    if(code===4902||/Unrecognized|not been added|unknown chain/i.test(String(e&&e.message||''))){
      await rpc('wallet_addEthereumChain',[{chainId:c.hex,chainName:c.name,nativeCurrency:{name:c.currency,symbol:c.currency,decimals:18},rpcUrls:[c.rpc],blockExplorerUrls:[c.explorer]}]);
    }else throw e;
  }
}
async function wait(hash){
  // 最多等 10 分钟：交易被钱包加速或替换后哈希会变，不能无限等下去
  for(let i=0;i<200;i++){const r=await rpc('eth_getTransactionReceipt',[hash]);if(r){log(r.status==='0x1'?'交易成功，区块 '+parseInt(r.blockNumber,16):'交易失败',r.status==='0x1'?'ok':'bad');return r.status==='0x1'}await new Promise(s=>setTimeout(s,3000))}
  log('10 分钟内没等到这笔交易上链（可能被钱包加速或替换了）。请在区块浏览器确认后点「核对链上结果」。','bad');return false;
}
async function send(to,data){
  const gas=await rpc('eth_estimateGas',[{from:account,to,data}]);
  log('预估 gas '+parseInt(gas,16));
  // 带上 chainId：用户在确认前切了网络时，钱包会拒绝而不是发到别的链
  const hash=await rpc('eth_sendTransaction',[{from:account,to,data,chainId:cfg().hex,gas:'0x'+Math.ceil(parseInt(gas,16)*1.2).toString(16)}]);
  log('已发送 '+hash+'，等待上链…');
  return wait(hash);
}
async function readImplSlot(addr){const s=await rpc('eth_getStorageAt',[addr,IMPL_SLOT,'latest']);return ('0x'+s.slice(-40)).toLowerCase()}

// 按链上现状决定哪一步可以点
async function refresh(){
  if(!(await onChain()))return;
  const c=cfg();
  const dcode=await rpc('eth_getCode',[DEPLOYER,'latest']);
  if(!has(dcode)){log('这条链上没有确定性部署器，停止。','bad');return}
  const bootOk=has(await rpc('eth_getCode',[BOOT,'latest']));
  const hubOk=has(await rpc('eth_getCode',[hubAddress,'latest']));
  const implOk=c.impl?has(await rpc('eth_getCode',[c.impl.address,'latest'])):false;
  const current=hubOk?await readImplSlot(hubAddress):null;
  const upgraded=!!(c.impl&&current===c.impl.address.toLowerCase());
  // 封印前提：该链 TapeOut 工厂已封印（否则电路合约再升级会让封印后的中枢永久停用）
  let factorySealed=false;
  if(c.impl){try{factorySealed=parseInt(await rpc('eth_call',[{to:c.impl.expect.factory,data:'0x631f9852'},'latest']),16)===1}catch{factorySealed=false}}
  // 与客户端 factoryStatus 的"封印生效"同一套条件：工厂实现是钉住的那一份、beacon 的 owner 是工厂、beacon 指向钉住的电路实现。
  // 只看 isSealed 不够：beacon 归别人所有时，它换掉电路实现，已封印的中枢会永久停用
  if(factorySealed){
    try{
      const e=c.impl.expect;
      const fImpl=await readImplSlot(e.factory);
      const bOwner='0x'+(await rpc('eth_call',[{to:e.circuitBeacon,data:'0x8da5cb5b'},'latest'])).slice(-40);
      const bImpl='0x'+(await rpc('eth_call',[{to:e.circuitBeacon,data:'0x5c60da1b'},'latest'])).slice(-40);
      const pinned=FACTORY_IMPL[chainId()];
      factorySealed=!!pinned&&fImpl===pinned&&bOwner.toLowerCase()===e.factory.toLowerCase()&&bImpl.toLowerCase()===e.circuitImplementation.toLowerCase();
      if(!factorySealed)log('工厂虽已封印，但工厂实现、beacon 的 owner 或电路实现与钉住的不符：不能封印中枢。','bad');
    }catch{factorySealed=false}
  }
  log(c.name+'：启动实现'+(bootOk?'已部署':'未部署')+'，中枢'+(hubOk?'已部署':'未部署')+(c.impl?'，正式实现'+(implOk?'已部署':'未部署')+'，中枢'+(upgraded?'已切换到正式实现':'尚未切换'):''));
  $('deployBoot').disabled=bootOk;
  $('deployProxy').disabled=!bootOk||hubOk;
  $('deployImpl').disabled=!c.impl||implOk;
  $('upgrade').disabled=!c.impl||!hubOk||!implOk||upgraded;
  $('seal').disabled=!upgraded||!factorySealed;
  if(upgraded&&!factorySealed)log('该链 TapeOut 工厂尚未封印：中枢暂时不能封印。','bad');
}

$('connect').onclick=async()=>{
  if(!window.ethereum){log('没有检测到浏览器钱包。','bad');return}
  try{
    [account]=await rpc('eth_requestAccounts');
    if(account.toLowerCase()!==EXPECTED_OWNER){log('连接的钱包是 '+account+'，不是预期的 owner '+EXPECTED_OWNER+'。用别的钱包会部署出另一个地址，各链地址就不一致了。请换成预期的钱包。','bad');account=null;return}
    log('已连接 '+account+'（预期的 owner）');
    await switchChain();
    hubAddress=create2(PROXY_SALT,proxyInitCode(account));
    $('hubAddr').textContent=hubAddress;
    if(hubAddress.toLowerCase()!==EXPECTED_HUB){log('算出的中枢地址与预期不一致，停止。','bad');account=null;return}
    log('中枢地址（各链相同）：'+hubAddress);
    await refresh();
  }catch(e){log('失败：'+(e&&e.message||e),'bad')}
};
function step(id,fn){
  $(id).onclick=async()=>{
    if(!account){log('先连接钱包。','bad');return}
    if(!(await onChain()))return;
    $(id).disabled=true;
    try{await fn()}catch(e){log('失败：'+(e&&e.message||e),'bad')}
    await refresh();
  };
}
step('deployBoot',async()=>{await send(DEPLOYER,BOOT_DATA)});
step('deployProxy',async()=>{
  // proxyInitCode 以 0x 开头：拼在 salt 后面要去掉
  await send(DEPLOYER,PROXY_SALT+proxyInitCode(account).slice(2));
});
step('deployImpl',async()=>{const c=cfg();if(!c.impl)return;await send(DEPLOYER,c.impl.txData)});
step('upgrade',async()=>{
  const c=cfg();if(!c.impl)return;
  const data='0x4f1ef286'+pad(c.impl.address)+pad('40')+pad('0');  // upgradeToAndCall(impl, "")
  await send(hubAddress,data);
});
$('verify').onclick=async()=>{
  if(!window.ethereum){log('没有检测到浏览器钱包。','bad');return}
  if(!hubAddress){log('先连接钱包。','bad');return}
  if(!(await onChain()))return;
  const c=cfg();
  if(!has(await rpc('eth_getCode',[hubAddress,'latest']))){log('这条链上的中枢地址还没有合约。','bad');return}
  let all=true;
  const own='0x'+(await rpc('eth_call',[{to:hubAddress,data:'0x8da5cb5b'},'latest'])).slice(-40);
  const pend='0x'+(await rpc('eth_call',[{to:hubAddress,data:'0xe30c3978'},'latest'])).slice(-40);
  const okPend=pend==='0x'+'0'.repeat(40);all=all&&okPend;
  log('待接受的新 owner = '+(okPend?'无  ✓':pend+'  ✗ 有人正在接手管理权'),okPend?'ok':'bad');
  const isSealed=parseInt(await rpc('eth_call',[{to:hubAddress,data:'0x631f9852'},'latest']),16)===1;
  const slot=await readImplSlot(hubAddress);
  const okOwner=isSealed?own==='0x'+'0'.repeat(40):own.toLowerCase()===account.toLowerCase();all=all&&okOwner;
  log('owner = '+own+(isSealed?'（已封印）':'（未封印：owner 可升级）')+(okOwner?'  ✓':'  ✗'),okOwner?'ok':'bad');
  if(!c.impl){
    const okBoot=slot===BOOT.toLowerCase();all=all&&okBoot;
    log('实现槽 = '+slot+(okBoot?'  ✓ 启动实现（这条链暂时收发不了消息）':'  ✗ 应为启动实现 '+BOOT),okBoot?'ok':'bad');
  }else if(slot===BOOT.toLowerCase()){
    log('实现槽仍是启动实现：请做第 4、5 步。','bad');all=false;
  }else{
    const okSlot=slot===c.impl.address.toLowerCase();all=all&&okSlot;
    log('实现槽 = '+slot+(okSlot?'  ✓':'  ✗ 应为 '+c.impl.address),okSlot?'ok':'bad');
    // 合约里容器实现的读取函数叫 accountImplementation，部署参数里对应的键叫 implementation
    const EXPECT_KEY={accountImplementation:'implementation'};
    for(const [k,sel] of Object.entries(SEL)){
      const want=c.impl.expect[EXPECT_KEY[k]||k];
      const got='0x'+(await rpc('eth_call',[{to:hubAddress,data:sel},'latest'])).slice(-40);
      const ok=!!want&&got.toLowerCase()===want.toLowerCase();all=all&&ok;
      log(k+' = '+got+(ok?'  ✓':'  ✗ 应为 '+want),ok?'ok':'bad');
    }
    // 第三版起：实现合约必须报出"我就是我自己"
    const selfAddr='0x'+(await rpc('eth_call',[{to:c.impl.address,data:'0x12e905b0'},'latest']).catch(()=>'0x')).slice(-40);
    const okSelf=selfAddr.toLowerCase()===c.impl.address.toLowerCase();all=all&&okSelf;
    log('实现合约 selfAddress = '+selfAddr+(okSelf?'  ✓':'  ✗'),okSelf?'ok':'bad');
    const ch=await rpc('eth_call',[{to:hubAddress,data:'0x86763c31'},'latest']);
    const okCh=ch.toLowerCase()===c.impl.expect.circuitCodehash.toLowerCase();all=all&&okCh;
    log('circuitCodehash = '+ch+(okCh?'  ✓':'  ✗'),okCh?'ok':'bad');
    const mp=parseInt(await rpc('eth_call',[{to:hubAddress,data:'0xcfdd2b73'},'latest']),16);
    const okMp=mp===16000;all=all&&okMp;log('MAX_PAYLOAD = '+mp+(okMp?'  ✓':'  ✗'),okMp?'ok':'bad');
  }
  log('提示：本页的核对读的是钱包自带的节点。要独立复核，请在源码目录运行 forge script script/Deploy.s.sol 连公共节点再核一遍。');
  log(all?'核对通过：'+c.name+' 上的中枢位于 '+hubAddress+(isSealed?'，已封印':'，尚未封印'):'核对未通过，不要使用这个地址。',all?'ok':'bad');
};
$('seal').onclick=async()=>{
  if(!hubAddress){log('先连接钱包。','bad');return}
  if(!(await onChain()))return;
  if(!confirm('封印不可撤销：'+cfg().name+' 上中枢的 owner 将被置零，升级入口永久关闭。确定吗？'))return;
  $('seal').disabled=true;
  try{
    if(await send(hubAddress,'0x3fb27b85')){
      const s=parseInt(await rpc('eth_call',[{to:hubAddress,data:'0x631f9852'},'latest']),16)===1;
      log(s?'已封印：这条链的中枢从此不可升级，没有 owner。':'封印状态读回来不是 1，请检查。',s?'ok':'bad');
    }
  }catch(e){log('失败：'+(e&&e.message||e),'bad')}
  await refresh();
};
</script></body></html>`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist/deploy-deweb-hub.html');
fs.writeFileSync(out, page);
console.log(JSON.stringify({
  boot: getAddress(bootAddress),
  bscHubImplementation: chainData[56].impl.address,
  bootSalt: SALT_BOOT,
  proxySalt: SALT_PROXY,
  hubImplSalt: SALT_HUB_IMPL,
  page: out,
}, null, 2));
