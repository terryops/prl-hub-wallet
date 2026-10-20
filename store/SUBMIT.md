# Chrome 商店注册与提交清单（Pearl Hub Wallet 0.1.2）

按商店后台的顺序逐项填写。英文文案取自 `store/en.json`，其他语言取自对应的 `store/<语言>.json`。

## 一、注册开发者账号（必须本人操作）

1. **选定开发者邮箱**：官方说明这个邮箱注册后不能更改。建议用一个长期使用的 Google 账号，可以专门新建一个，并开启两步验证。
2. 打开开发者控制台 https://chrome.google.com/webstore/devconsole ，用这个账号登录。
3. 同意开发者协议和政策，支付一次性注册费（以页面显示的金额为准）。
4. 确认你所在的国家或地区在支持名单里，否则商店不接受注册和提交。
5. 在账号设置里填写：
   - **发布者名称**（必填）：显示在商店的「提供方」，建议填 `Pearl Hub`。
   - **联系邮箱**（必填）：点「Verify email」，再点收到的验证链接。
   - **实体地址**：只有插件内提供购买、附加功能或订阅时才必填。插件本身不卖东西，Pro 在网页和 App 购买。
   - 如果控制台要求声明是否以「交易者」（trader）身份发布（欧盟《数字服务法》），这是法律判断，需要你自己决定。选交易者需要公开地址、电话和邮箱。

## 二、新建条目并上传

- 上传 **`extension/pearl-hub-wallet-0.1.2-store.zip`**。它和网站包的唯一区别是清单里没有 `key`：商店会分配自己的插件 ID，不接受这个字段。不要上传网站用的 `pearl-hub-wallet-0.1.2.zip`。
- 2026-10-15 先上传 0.1.1 并提交了审核。同日撤回审核（⋮ 菜单 → Cancel review），换成 0.1.2 的商店包后重新提交，勾选审核通过后自动发布。审核中不能上传新包。
- **上传后先不要发布。** 在 Package 页记下商店分配的 Item ID 发给我（2026-10-15 已上传，Item ID 为 `amomopjmejbdinidepgbhlkgknkonhah`；回调地址当天已加进 `ACCOUNT_REDIRECTS` 并发布，Worker 版本 `2ea401a9`）。服务端要把 `https://<Item ID>.chromiumapp.org/account` 加进 `ACCOUNT_REDIRECTS`，否则商店版的邮箱登录（联系人同步）会失败。这需要一次 Worker 发布。

## 三、Store listing（商店信息）

- 名称和简短说明来自插件包内的 `_locales`，会自动显示，不用另外填。
- 详细说明：默认语言选英语，再逐个添加其他 15 种语言：

| 商店语言 | 详细说明 | 截图 |
| --- | --- | --- |
| English（默认语言） | `store/en.json` 的 `detailedDescription` | `store/screenshots/en-*.png`（5 张） |
| Russian | `store/ru.json` 的 `detailedDescription` | `store/screenshots/ru-*.png`（5 张） |
| Chinese (China) | `store/zh-Hans.json` 的 `detailedDescription` | `store/screenshots/zh-Hans-*.png`（5 张） |
| Chinese (Taiwan) | `store/zh-Hant.json` 的 `detailedDescription` | `store/screenshots/zh-Hant-*.png`（5 张） |
| Vietnamese | `store/vi.json` 的 `detailedDescription` | `store/screenshots/vi-*.png`（5 张） |
| Indonesian | `store/id.json` 的 `detailedDescription` | `store/screenshots/id-*.png`（5 张） |
| Spanish | `store/es.json` 的 `detailedDescription` | `store/screenshots/es-*.png`（5 张） |
| Portuguese (Brazil) | `store/pt-BR.json` 的 `detailedDescription` | `store/screenshots/pt-BR-*.png`（5 张） |
| French | `store/fr.json` 的 `detailedDescription` | `store/screenshots/fr-*.png`（5 张） |
| German | `store/de.json` 的 `detailedDescription` | `store/screenshots/de-*.png`（5 张） |
| Italian | `store/it.json` 的 `detailedDescription` | `store/screenshots/it-*.png`（5 张） |
| Turkish | `store/tr.json` 的 `detailedDescription` | `store/screenshots/tr-*.png`（5 张） |
| Japanese | `store/ja.json` 的 `detailedDescription` | `store/screenshots/ja-*.png`（5 张） |
| Korean | `store/ko.json` 的 `detailedDescription` | `store/screenshots/ko-*.png`（5 张） |
| Hindi | `store/hi.json` 的 `detailedDescription` | `store/screenshots/hi-*.png`（5 张） |
| Thai | `store/th.json` 的 `detailedDescription` | `store/screenshots/th-*.png`（5 张） |

- 类别：选最接近钱包的一项（例如「Tools / 工具」），以控制台当前的列表为准。
- 商店图标 128×128：`store/icon-128.png`
- 小宣传图 440×280：`store/promo-small.png`。大宣传图 1400×560 可选，没有准备。
- 截图 1280×800：每种语言 5 张，依次是浅色钱包、深色钱包、地址簿、转账预览、捐赠预览。余额是模拟的 25 PRL，没有真实交易。
- 官方网址：https://pearlhub.net
- 支持网址：https://pearlhub.net/support

## 四、Privacy practices（隐私做法）

**单一用途（Single purpose）**

> A self-custody wallet for the Pearl (PRL) cryptocurrency: create or restore wallets, view balances and history, receive, and sign and send PRL transactions on this device.

**权限理由**（四项 API 权限各一个输入框；三个主机权限共用一个「Host permission justification」输入框，上限 1000 字符，填写时每段前面标上对应的域名）

| 权限 | 理由 |
| --- | --- |
| `storage` | Locally stores encrypted wallets, encrypted pending transactions, public contacts and preferences; the trusted session holds the unlock key until lock. No Chrome account sync. |
| `alarms` | Checks inactivity once per minute to enforce the 5-minute automatic lock. |
| `sidePanel` | Opens the packaged wallet UI in the browser side panel when its toolbar icon is clicked. |
| `https://blockbook.pearlresearch.ai/*` | Fallback for mainnet balances, public account/address history, UTXOs, fees and transaction status when Pearl Hub's own index is unavailable or behind; transaction lookups and explicitly confirmed locally signed broadcasts go to both. |
| `https://blockbook.testnet.pearlresearch.ai/*` | Same chain queries and explicitly confirmed broadcasts, restricted to testnet. |
| `https://pearlhub.net/*` | Pearl Hub's own blockchain index at pearlhub.net/node is asked first for balances, address history, UTXOs, fees and transaction status (sending the wallet's public account key and addresses) and receives explicitly confirmed signed transactions. Public market requests carry no wallet identity. Optional email account login and authenticated configuration sync share contact names, public addresses and notes. Account data is encrypted at rest and readable by the server; wallet seed phrases, private keys and passwords are never uploaded. |
| `identity` | Opens the Pearl Hub email sign-in page and receives a one-use PKCE authorization callback. Does not read your Google or Microsoft account. |

**远程代码（Remote code）**：选 No, I am not using remote code（不使用远程代码）。

**数据使用**：建议勾选下面三项，最终由你确认后提交（参考 `store/en.json` 的 `dataUseDisclosure`）。官方要求如实申报，这里不能选「不收集任何数据」。

- 个人身份信息：可选的邮箱账号登录会用到邮箱地址。
- 财务和付款信息：公开地址、余额、交易记录和已签名的交易，先发给我们自建的区块索引（pearlhub.net/node），官方 Blockbook 作为备用；已签名交易同时发给两边。
- 身份验证信息：邮箱账号的登录令牌会发给 pearlhub.net；助记词、私钥和密码只留在本机。

位置、网页浏览记录、用户活动、网站内容、通信、健康都不勾选：插件不收集 IP，只有网络基础设施能看到 IP。

三项承诺都勾选：不出售数据，不用于无关用途，不用于判断信用或放贷。

**隐私政策网址**：https://pearlhub.net/privacy （已涵盖 Chrome 钱包插件）

## 五、给审核员的说明（Test instructions）

填在「Additional instructions」，上限 500 字符，用户名和密码留空。

> No account needed. Open the side panel, choose "Create wallet", write down the 12 words and set a password. To avoid real funds, open Wallet settings (sliders icon) and set Wallet network to Testnet. Recovery phrases, private keys and password never leave the device; chain data comes from blockbook.pearlresearch.ai. Sending and the optional donation broadcast real mainnet transactions only after a preview and password confirmation. Email sign-in is optional; contact sync needs Pearl Hub Pro.

## 六、Distribution（分发）

- 可见性：「公开」所有人可搜到；「不公开」（Unlisted）只能通过链接安装，适合先自测。
- 地区：所有地区。
- 填完后提交审核。钱包类插件的审核可能比一般插件久，审核结果会发到联系邮箱。

## 七、用 API 提交新版本（0.1.3 起）

**0.1.5 改了数据流向**（余额、记录和广播先走我们自建的区块索引 pearlhub.net/node）。提交 0.1.5 前先在后台「Privacy practices」里把 `pearlhub.net` 和 `blockbook.pearlresearch.ai` 的权限理由换成上表的新文字（三个主机权限合计 960 字符，限 1000），并核对数据使用说明；API 只上传安装包，不改这些文字。隐私政策 https://pearlhub.net/privacy 也要先更新（`prl-hub/site/privacy.html`）。

新版本不用再开商店后台：`scripts/store-release.mjs` 通过 Chrome Web Store API v2 上传商店包并提交审核。Chrome 不允许任何扩展操作商店后台页面，所以浏览器自动化做不了这一步。

```sh
npm run store:status   # 已发布和审核中的版本
npm run store:submit   # 上传 pearl-hub-wallet-<package.json 版本>-store.zip 并提交审核，审核通过后自动发布
node scripts/store-release.mjs submit --staged   # 审核通过后先暂存，在后台手动发布
```

脚本只上传已经打好的包，不会重新打包：商店包要在本仓库提交过的版本上用 `npm run package` 打出（公开仓库即源码，见 README「Verify a package」），再提交。上传前它会检查包里清单的版本等于 `package.json`、没有 `key`、当前没有审核中的提交。

授权（2026-10-16 配置）：Google Cloud 项目 `pearl-hub-store-release`（属于 breathlex@gmail.com）里的服务账号 `cws-publisher@pearl-hub-store-release.iam.gserviceaccount.com`，已在商店后台 Account 页加为发布者的服务账号（每个发布者只能加一个）。没有密钥文件：脚本用 gcloud 以 breathlex@gmail.com 的身份模拟这个服务账号，临时换取令牌（breathlex@gmail.com 在服务账号上有 `roles/iam.serviceAccountTokenCreator`）。换一台电脑时先运行 `gcloud auth login breathlex@gmail.com --no-activate`，不会改变 gcloud 当前的默认账号。
