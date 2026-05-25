# 羽毛球 Drop-in 排队管理 Web 版

参考微信小程序 `PasscodeManager_WeChat` 制作的网页版，可部署到 Vercel。功能包括：

- 创建/加入球群，通过分享链接协作
- 可选 Google 登录；未登录用户可添加账号，登录用户可修改/删除自己登录后添加的账号
- 登录后可设置 display name、查看参与过的球群和个人打球历史热力图
- 添加账号池，限制用户名和密码只包含英文或数字
- 按场地排队，支持 2 人半场、4 人整组
- 首次录入场地时可填写当前剩余分钟和前方排队组数
- 自动计算上场时间、等待分钟和第几组
- 补全半场、取消半场或整组
- 按美国西部 PT 时间午夜清理当天账号和排队数据

## 本地运行

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

本地未配置 Redis 时会使用内存存储，重启服务后数据会清空。

## 部署到 Vercel

这个项目不需要构建步骤，直接导入 Vercel 即可。

生产环境建议绑定 Vercel KV 或 Upstash Redis，并配置环境变量：

```text
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

也兼容 Upstash 原生命名：

```text
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

如果没有配置 Redis，Vercel Serverless 会退回内存模式，数据可能随函数冷启动丢失，不适合正式使用。

如需启用 Google 登录，还需要在 Google Cloud Console 创建 Web OAuth Client，并在 Vercel 配置：

```text
GOOGLE_CLIENT_ID=...
```

授权来源需要包含你的 Vercel 域名，例如 `https://your-app.vercel.app`。

## 文件结构

```text
index.html      网页入口
styles.css      界面样式
app.js          前端交互逻辑
api/app.js      Vercel Serverless API 和排队业务逻辑
dev-server.js   零依赖本地开发服务器
vercel.json     Vercel 路由与函数配置
```
