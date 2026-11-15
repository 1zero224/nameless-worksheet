# 部署时复用 VPS 上现有的 Caddy，而不是自带一个

设计文档原定 Docker Compose 里包含应用、PostgreSQL 和 Caddy 三个服务。实际使用的 VPS 与其他服务共用，80/443 已被 `/opt/gotify/compose.yaml` 里的 Caddy 容器占用，它已经为机器上多个站点做反向代理。用户决定复用它：在 `/opt/gotify/Caddyfile` 里追加一个站点块，应用容器只把端口发布到 `172.19.0.1`（该 Caddy 所在 Docker 网络的网关地址，机器上其他站点都是这个写法），不对公网直接暴露。

## 考虑过的方案

- 自带 Caddy 监听其他端口：地址要带端口号，证书签发也更麻烦。
- 换一台专用 VPS：最干净，但现在没有必要多花钱。

## 后果

- 工作台的入口配置不在本仓库的 Compose 里，而在另一个项目的 Caddyfile 中；本仓库的 `deploy/Caddyfile.snippet` 是它的来源，两处要保持一致。
- `172.19.0.1` 取决于 `gotify_gotify-internal` 这个网络；若该网络被重建导致网段变化，应用的端口绑定与站点块要一起改。
- `deploy/compose.caddy.yaml` 保留自带 Caddy 的写法，供换到干净机器时使用。
