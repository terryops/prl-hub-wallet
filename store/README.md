# Pearl Hub Wallet 0.1.2 商店资料

首个公开版本为 0.1.0（只在网站提供下载）。0.1.1 起图标改用 Ionicons，不再包含 SF Symbols，商店首次上架应使用 0.1.1 或更新的版本。0.1.2 在钱包设置里加了安全性说明，源码公开在 https://github.com/terryops/prl-hub-wallet 。下文历史记录里的 0.2.x / 0.3.x 是首发前的内部开发版本号，商店从未上架过这些版本。

这里只准备资料和验证流程，不执行上传、提交审核或发布。注册开发者账号和逐项填写商店表单见 `SUBMIT.md`。

- `store/*.json`：16 种语言的名称、简短说明、详细说明、七项权限/主机权限用途、数据使用披露。名称与简短说明同时用于 `public/_locales/`。
- `screenshots/`：运行下述脚本后得到每种语言五张 1280×800 PNG：浅色钱包、深色钱包、通讯录、转账预览、捐赠预览。合计 80 张，余额统一为模拟 25 PRL。
- `icon-128.png`：截图脚本把现有 192×192 logo 渲染成商店所需的 128×128 PNG；`package.py` 在该文件存在时自动用它替换 ZIP 中的 icon.png，未生成时仍可打开发包，但不能当作完成图标准备的商店包。
- `promo-small.png`：同一脚本生成 440×280 宣传图，使用插件已有图标，不伪造钱包界面。
- `public/privacy.html`：随插件打包的隐私说明。商店表单要填的公开隐私政策网址是 https://pearlhub.net/privacy ，2026-10-15 核对过，已涵盖 Chrome 钱包插件。

## 本地生成与验证

在 `extension/` 内运行：

```sh
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run qa
npm run qa:languages
npm run qa:review
npm run store:screenshots
npm run qa:edge
npm run package
```

默认 QA 使用隔离 profile、公开 BIP39 向量、链上样本和固定行情样本。浏览器页面的 HTTP 请求和扩展后台的签名广播均拦截；不存在真实交易。`qa:review` 会再次构建 extension，不构建其他目录。截图脚本只做预览，不调用 send。各脚本退出时删除临时 profile。

`npm run qa:edge` 使用本机安装的 Microsoft Edge（Playwright `msedge` channel），有界面启动同一份 MV3 dist，运行 B1–B5、320/360/390/1280 px 和深浅色检查。可以用 `PRL_QA_EXECUTABLE` 指定实际浏览器可执行文件；不要指向日常使用的 profile。若该版 Edge 拒绝命令行加载扩展，应执行下方手工加载检查，不能将失败改成通过或改用 Chromium 后标成 Edge。

如需在 Edge 复跑完整钱包功能和 16 种语言回归：

```sh
PRL_QA_BROWSER=msedge PRL_QA_HEADED=1 npm run qa
PRL_QA_BROWSER=msedge PRL_QA_HEADED=1 npm run qa:languages
```

可选 `PRL_QA_LIVE=1 npm run qa` 只增加旧脚本中的主网/测试网公开向量查询，不发送交易；行情和所有付款仍为样本。默认不依赖外网。新深链测试拦截目标网页，只核对新标签及 fragment，不验证线上网页实际打开添加面板或自动移除参数。

输出：`out/features/{chromium,msedge}-result.json` 记录浏览器版本、实际通过时间和样本标记；`out/multilang/` 保存 16 种语言的 320 px 捐赠图；`store/screenshots/generated.json` 记录截图尺寸、文件列表及模拟余额。失败会以非零退出码返回，不生成通过记录。使用最新输出，不能沿用旧版本记录。

## Edge 手工补充检查

1. 使用隔离测试 profile 打开 `edge://extensions`，打开开发者模式，加载 `extension/dist/`，确认版本 0.1.2 和四项 API / 三项主机权限。
2. 在工具栏点击插件图标，确认钱包侧边栏打开；点击 ↗ 确认完整页面打开。自动化会检查 sidePanel 配置，但不能替代工具栏实际点击。
3. 在运行样本 QA 的隔离环境核对复制、语言/副货币持久化、主网/测试网切换、通讯录、对方地址、捐赠两行完整地址、密码错误拒绝和网页新标签。不要用真实钱包资金试捐赠。
4. 记录 Edge 版本、系统、日期、自动化日志及手工侧边栏结果到本文件末尾，标明真实加载成功后，才能写“Edge 已验证”。

历史记录（0.2.0，2026-10-10，macOS）：

- Chromium 145.0.7632.6：`npm test` 65/65、`npm run build`、`npm run qa`（原有 15 项 + B1–B6）、`npm run qa:languages`（六种语言）全部通过；`npm run store:screenshots` 生成了 30 张 1280×800 截图、`icon-128.png` 和 `promo-small.png`。
- Microsoft Edge 137.0.3296.93：`npm run qa:edge`（B1–B6、320 / 360 / 390 / 1280 px、深浅色）通过。第一次运行失败是测试脚本的问题，不是插件的：Edge 自带扩展的后台进程排在前面，脚本取错了对象；`test/qa-support.mjs` 现在按清单内容找钱包自己的后台进程。
- **还没做**：在 Edge 里实际点击工具栏图标打开侧边栏（下方手工检查第 2 步），以及用真实资金的任何操作。所有通过记录都只用了样本，真实广播次数为 0。

## 机主上架步骤

1. 先完成上述沙箱外检查，人工查看 16 种语言的 320 px、深浅色、1280×800 截图；确认截图显示的 25 PRL 是样本，未发真实交易。审查说明及金融数据披露。
2. `npm run package` 产生网站用的 `pearl-hub-wallet-0.1.2.zip` 和商店用的 `pearl-hub-wallet-0.1.2-store.zip`（清单去掉 `key`，商店会分配自己的 ID）；确认 ZIP 根部是 `manifest.json`，不包含源码、node_modules、测试 profile 或任何密钥。固定 ID 相同的已有安装可覆盖并重新加载；若旧开发版 ID 不同，请按 `extension/README.md` 先备份助记词并在新安装中恢复，保留旧安装。
3. 准备开发者账号、联系信息、公开隐私政策 URL 和支持 URL。选择金融数据/钱包业务相应披露：插件在本机及 Blockbook 处理公开地址、余额、交易及签名交易；秘密凭据留在设备，联系人明文存本机。不能因为没有广告/统计就填“完全不使用数据”。IP 可被网络基础设施看到，不用于插件追踪。
4. Chrome Web Store 开发者控制台新建或更新条目，上传 ZIP，按 16 个 JSON 填本地化说明；每语言选对应五张截图，上传宣传图和生成的 `store/icon-128.png` 图标。按每项实际权限填写 justification 和单一用途“PRL 钱包管理”，说明没有远程可执行代码。
5. Edge Add-ons 通过 Microsoft Partner Center 单独建立或更新条目；上传已在 Edge 验证的同一份 ZIP，填写对应本地化、权限理由、隐私政策及数据使用信息。若商店检测提出兼容性要求，先修包并复测，不声明未验证兼容性。
6. 人工核对审核备注（公开测试向量、模拟余额、无真实交易、非独立审计），由机主自行提交审核和决定发布。本任务不登录商店、不上传文件、不提交、不发布。

官方参考（资料编写时核对）：[Chrome 商店图片要求](https://developer.chrome.com/docs/webstore/images)规定截图可用 1280×800，并需要 440×280 小宣传图；[Edge 发布说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)说明使用 Partner Center 并填写权限理由。实际商店表单变化以机主提交当天为准。

## 本轮验证（0.3.0，2026-10-12）

`npm test` 76/76、类型检查、构建、包含核心/功能/界面回归的 `npm run qa`、16 种语言回归及 `npm run qa:edge` 均通过。Edge 只验证自动化 MV3 页面和 sidePanel 配置，工具栏点击仍需按上面的手工步骤检查。

截图生成覆盖 16 种语言、每种五个场景，共 80 张 1280×800 图片。另生成 128×128 图标和 440×280 宣传图。本轮通过 `PRL_QA_SCREENSHOT_OUTPUT=out/ui-fix/store/screenshots npm run store:screenshots` 保存到忽略的 QA 目录；默认命令仍写入 `store/screenshots/`。128 组设置页与风险确认弹窗的多语言、320/390 px、深浅色布局通过检查。记录与截图位于 `out/ui-fix/`，所有请求及付款使用隔离样本，真实广播次数为 0。
