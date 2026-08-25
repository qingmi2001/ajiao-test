

第一步：绑定 Cloudflare KV 命名空间
登录 Cloudflare Dashboard，进入 Workers & Pages -> KV。

点击 Create a Namespace（创建命名空间），名称填写 SUB_KV，点击添加。

进入你创建的 Worker 项目，点击 Settings -> Variables and Secrets（变量与机密）。

找到 KV Namespace Bindings，点击 Add binding：

Variable name（变量名）必须填写：SUB_KV

KV namespace 选择刚才创建的 SUB_KV。

点击 Deploy 保存生效。

第二步：完整 Worker 代码（含可视化前端 + 订阅生成）
