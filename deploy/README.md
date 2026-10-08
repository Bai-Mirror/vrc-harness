# harness.nymiro.moe 部署

服务端（`server/`）、容器定义（`deploy/harness-server/`）与 nginx 站点块（`deploy/nginx/harness.nymiro.moe.conf`）的上线、发布与回滚步骤。仓库里的东西只是准备好的材料：照下面做之前，线上什么都没变。

## 1. 服务器上的位置

| 宿主机路径 | 用途 | 挂进哪个容器 |
|---|---|---|
| `/docker/harness-server/docker-compose.yml`、`.env` | 从 `deploy/harness-server/` 复制；`.env` 写 `HARNESS_REPO=./src` | — |
| `/docker/harness-server/src/` | 要上线那个提交的 `git archive` 导出，镜像从这里构建 | 构建上下文 |
| `/docker/harness-server/config/trusted-keys.json` | 受信公钥 `{keyId: 公钥 PEM}`，**只放公钥** | harness-server `/config`（只读） |
| `/docker/harness-server/data/` | `DATA_DIR`，属主 uid 1000（镜像里的 `node` 用户；本机 nymiro 就是 1000） | harness-server `/data` |
| `/docker/harness-server/data/releases/` | 发行清单与下载文件 | nginx-nymiro `/srv/harness/releases`（只读） |
| `/docker/harness-server/site/` | 宣传站，由仓库 `site/` 同步而来 | nginx-nymiro `/srv/harness/site`（只读） |

`data/` 里：

- `contributions/<receiptId>/`：`bundle/`（`contribution.json` 与 `pack/`，原样字节）与 `meta.json`（接收时间、安装 ID、用户名、字节数、校验时的精确权限）。存下的文件只保留「可执行或不可执行」（0644/0755），任何内容都不执行、不解压。**不记录 IP。**
- `installations/<installId>/`：每次客户端安装各有随机令牌，服务器只存令牌哈希、结构化记录批次和该安装的贡献索引；`tokens/` 是哈希索引。状态查询与撤回只作用于该安装。撤回删除尚未采纳的记录与贡献；已纳入签名发行的条目单列说明。
- `quarantine/`：正在校验的上传；每次启动清空。
- `releases/app/<channel>/*.json` 与 `releases/app/files/`：软件发行清单与安装包。
- `releases/knowledge/<channel>/*.json` 与 `releases/knowledge/files/`：知识包发行清单与 `<releaseId>.tar.gz`。
- 频道名就是目录名（字母数字开头，`files` 保留）。清单每次请求都会重新读取并用受信公钥验签；验不过的不返回，并在容器日志里告警一次。

`POST /v1/installations` 开放注册，但 nginx 对每个来源限速；`/v1/records`、`/v1/contributions`、`/v1/contributions/status` 与 `/v1/consents/revoke` 都要求该安装自己的 Bearer 令牌。回传相关路径的 nginx 访问日志不保存来源地址。令牌区分数据归属，不证明客户端身份；上传内容仍按白名单和限额校验。

## 2. 首次上线

```sh
REPO=~/code/vrc-harness   # 含要上线提交的仓库检出（按实际位置改）
REV=<提交或标签>
H=/docker/harness-server
N=/docker/nginx-nymiro
```

**① 目录与代码**（harness-server 以 uid 1000 写 `data/`；nginx 以 uid 101 只读 `site/` 与 `data/releases/`）

```sh
install -d -m 755 $H $H/config $H/site
install -d -m 700 $H/data
install -d -m 755 $H/data/releases $H/data/releases/app/files $H/data/releases/knowledge/files
rm -rf $H/src.new && mkdir $H/src.new
git -C $REPO archive $REV server harness/package.json harness/src deploy site | tar -x -C $H/src.new
[ -d $H/src ] && mv $H/src $H/src.prev; mv $H/src.new $H/src
cp $H/src/deploy/harness-server/docker-compose.yml $H/
cp $H/src/deploy/harness-server/.env.example $H/.env
```

**② 受信公钥**（私钥始终留在维护者机器上，不上服务器）

> **密钥已于 2026-09-30 轮换**：`harness-dev-1` 已移入 `~/.local/share/avh-release-keys/retired/`，**在用的签名密钥是 `harness-dev-2`**（线上三个已公布知识清单的 `keyId` 均为它）。**下面三条命令此前仍写 `harness-dev-1`，照抄会因为那个路径上已没有文件而失败。**

```sh
node $H/src/server/scripts/trusted-keys.mjs --out $H/config/trusted-keys.json \
  harness-dev-2=$HOME/.local/share/avh-release-keys/harness-dev-2.pub
```

**③ 构建并启动服务**（构建需联网：拉 `node:24-slim`；镜像不装任何 npm 包）

```sh
cd $H && docker compose build && docker compose up -d
docker compose ps                     # 等到 healthy
docker exec harness-server node -e "fetch('http://127.0.0.1:8080/v1/capabilities').then(r=>r.json()).then(console.log)"
```

**④ 同步宣传站**（`site/` 下的 `*.md` 是设计与调研笔记，不发布）

```sh
rsync -a --delete --exclude='*.md' --exclude='.*' $H/src/site/ $H/site/
```

**⑤ nginx**：这一步影响本机所有站点，先备份。

```sh
TS=$(date +%Y%m%d-%H%M%S)
cp -a $N/conf $N/conf.bak.pre-harness-server.$TS
cp $N/docker-compose.yml $N/docker-compose.yml.bak.pre-harness-server.$TS
```

5a. 在 `$N/docker-compose.yml` 的 `volumes:` 下追加两行，然后重建容器。此时仍是旧配置，所有站点会中断几秒：

```yaml
      - /docker/harness-server/site:/srv/harness/site:ro
      - /docker/harness-server/data/releases:/srv/harness/releases:ro
```

```sh
cd $N && docker compose up -d && docker compose ps
```

5b. 换站点块：删掉 `$N/conf/default.conf` 里从 `# ─── harness.nymiro.moe —— Avatar Harness 产品站点（占位）` 到 `# ── learn.nymiro.moe` 之前的整段占位 `server` 块（两个块同名时 nginx 只告警、只用前一个，新块会被忽略），再放入新文件，检查通过后平滑重载：

```sh
cp $H/src/deploy/nginx/harness.nymiro.moe.conf $N/conf/
docker exec nginx-nymiro nginx -t && docker exec nginx-nymiro nginx -s reload
```

`nginx -t` 不通过时旧配置照常运行；先按第 5 节还原 `conf/` 再排查。

**⑥ 验证**

```sh
curl -sS https://harness.nymiro.moe/v1/health
curl -sS https://harness.nymiro.moe/v1/capabilities
curl -sSI https://harness.nymiro.moe/ | head -n 1
```

## 3. 发布

签名在维护者机器上做，服务器只接收签好的文件。顺序是 **构建 → 两道构建判据 → 放下载文件 → 签名 → 放清单 → 核对下载地址**：先放文件、后放清单，清单才不会指向不存在的文件。

**构建判据**（`npm run check` 不构建安装包，所以这两道判据不显式调用就不会执行）：

```sh
cd harness
npm run release:check -- <安装包路径>
```

依次执行 `check:release-artifacts`（把构建者的私有路径从成品字节里读回来）与 `check-installer-location`（驱动安装包跑安装位置用例），任一失败即以非零状态退出，首个失败的判据之后的判据不再执行；不带参数只打印中文用法并 exit 2。

**软件**：

```sh
# 1) 先放安装包；加 --verify-urls 时，签名脚本要求这些 URL 此刻已经可取
cp <安装包> $H/data/releases/app/files/

# 2) 签名：脚本先把将写入清单的每个下载 URL 打印出来；加 --verify-urls 还会对每个 URL 发 HEAD，
#    不是 200 就拒绝签名，并提示「先放文件、后放清单」
node server/scripts/app-release.mjs --version 0.1.0-dev.1 --channel dev \
  --key ~/.local/share/avh-release-keys/harness-dev-2.key --key-id harness-dev-2 \
  --notes-file notes.md --file win32-x64:nsis:<安装包路径> --out app-0.1.0-dev.1.json

# 3) 最后放清单
install -d -m 755 $H/data/releases/app/dev && cp app-0.1.0-dev.1.json $H/data/releases/app/dev/

# 4) 逐个确认下载地址（服务端不替 app 清单检查文件是否存在，这一步不能省）
curl -sSI https://harness.nymiro.moe/v1/releases/files/<文件名> | head -n 1   # 期望 200
```

**`--file` 的 platform 键必须与客户端的 `${process.platform}-${process.arch}` 一致**（`harness/src/app-release.ts:66`）：Windows 安装包写 `win32-x64:nsis`，Linux 写 `linux-x64:deb`。**实测**：写成 `windows-x64` 时发行仍会列出，但客户端按平台过滤后 `files=[]`，用户只看到「有新版本但没有可下载文件」。

下载地址默认是 `https://harness.nymiro.moe/v1/releases/files/<文件名>`（`--base-url` 可改）。已有清单要补签或重签时用 `sign-release.mjs`。

**知识包**（Git 工作树里只打包已跟踪的文件，被忽略的 `knowledge/SOP/` 之类不会进包）：

```sh
node server/scripts/pack-knowledge.mjs --pack harness/builtin --version 0.1.0-dev.2 --channel dev \
  --key ~/.local/share/avh-release-keys/harness-dev-2.key --key-id harness-dev-2 \
  --previous builtin-linux-rc5 --out /tmp/knowledge-0.1.0-dev.2
cp /tmp/knowledge-0.1.0-dev.2/*.tar.gz $H/data/releases/knowledge/files/
install -d -m 755 $H/data/releases/knowledge/dev && cp /tmp/knowledge-0.1.0-dev.2/*.json $H/data/releases/knowledge/dev/
```

每次发行都要新的 packId（默认 `vrc-knowledge-<版本>`），客户端按 packId 去重。知识包清单里**没有**下载地址（客户端按 endpoint 自己拼），服务端只对**归档**做存在性检查：归档缺失时该发行不会列出，并在日志里写 `archive files/<name> is missing`——所以归档必须先于清单到位。

**撤回**：删掉对应的清单 `.json`，立即生效；下载文件可以留着。新签名密钥：`keygen.mjs <仓库外的目录> <keyId>` 生成，`trusted-keys.mjs` 加进 `trusted-keys.json`，然后 `docker compose restart`（公钥只在启动时读取）。

## 4. 更新服务端

```sh
docker tag harness-server:local harness-server:rollback
```

清理旧镜像时保留回滚标签：`docker image prune --filter 'label!=moe.nymiro.keep=true'`。

然后重做第 2 节 ①（导出新 `REV`），再 `cd $H && docker compose build && docker compose up -d`。宣传站单独更新时重做 ① 与 ④。

## 5. 回滚

- **服务**：`docker tag harness-server:rollback harness-server:local && cd $H && docker compose up -d --no-build`；或 `rm -rf $H/src && mv $H/src.prev $H/src` 后重新构建。回滚到无安装令牌的旧版本会重新开放匿名贡献接口，须先在 nginx 暂停 `/v1/contributions` 与回传相关路径；`data/` 保留现场，不自动删除新格式文件。
- **站点块**：`rm $N/conf/harness.nymiro.moe.conf`，把备份的 `default.conf` 拷回（`cp $N/conf.bak.pre-harness-server.$TS/default.conf $N/conf/`），`docker exec nginx-nymiro nginx -t && docker exec nginx-nymiro nginx -s reload`。
- **nginx 挂载**：`cp $N/docker-compose.yml.bak.pre-harness-server.$TS $N/docker-compose.yml && cd $N && docker compose up -d`。
- **整体下线服务**：`cd $H && docker compose down`；`/v1/` 随之返回 502，站点其余部分不受影响。

## 6. 运行要点

- **备份实际口径**：当前 compose 显式 `BACKUP_DAYS=0`，未部署贡献数据的定时备份，不向客户端宣称14天备份。代码/镜像回滚副本与贡献载荷备份分开。维护者启用定时备份时，同时核对有限保留、恢复后撤回记录重放和客户端告知，才更改该值；手工保存的数据副本也必须计入实际策略。

- **上限**：上传解码后 64 MiB、至多 2000 个文件；请求体 90 MiB；同时处理 2 个上传，多出的回 503；`DATA_DIR` 所在磁盘剩余少于 `MIN_FREE_BYTES`（2 GiB）时回 507。两个 64 MiB 上传同时进来，进程驻留内存峰值实测约 630 MiB，所以容器上限给 1g。
- **nginx 限流**：`/v1/contributions` 与安装注册每 IP 每分钟 6 次、突发 3；其余 `/v1/` 每 IP 每秒 5 次、突发 10；全站每 IP 10 个并发连接。HTTP/2 下每个并发请求各算一个连接：页面一次并发取超过 10 个资源时，超出的会拿到 429。
- **日志与请求头**：所有 `/v1/` API 的访问日志均使用 `harness_anon`，包括回传接口的尾斜杠和后续新增路径，不记客户端地址、查询串、请求体与 Referer。静态站访问日志另按站点政策处理。API 反代显式关闭原请求头转发，仅允许 Host、X-Forwarded-Proto、Authorization、Content-Type 和 Accept；请求体的长度或分块由 nginx 生成，不能把用户提交的地址、Cookie 或任意自定义请求头透传给服务端。服务端日志只有接收回执号、清单告警与内部错误。第三方 CDN 自身的日志不因此取得匿名证明。
- **环境变量**：`HOST`、`PORT`、`DATA_DIR`、`TRUSTED_KEYS_FILE`、`PUBLIC_BASE_URL`（知识包下载地址的前缀）、`MIN_FREE_BYTES`、`SERVE_RELEASE_FILES=1`（开发用：让服务端自己提供两个下载目录，生产由 nginx 提供）。

### API 反代的隔离验收与单文件更新

新增回传端点时，服务镜像与挂载的 nginx 配置必须一起核对。仅更新服务镜像不会让新端点自动获得匿名日志和请求头边界。

`deploy/tests/nginx-api-boundary.py` 使用唯一 Docker 内部网络、临时自签证书和合成 echo 上游，没有宿主端口、生产挂载或真实令牌。仓库入口是 `harness/scripts/nginx-boundary.mjs`（`cd harness && npm run check:nginx-boundary`，或 `npm run check -- --nginx-boundary`）：它自动找出本机已有的 nginx 与 Node 镜像，也可用 `--nginx-image`／`--upstream-image` 或 `AVH_NGINX_TEST_IMAGE`／`AVH_NODE_TEST_IMAGE` 指定。**Docker 守护进程、openssl 或 Python 3 不可用、或找不到镜像时，它以退出码 3 明确跳过并说明原因——跳过不是通过，也不写验收 JSON**；总检查把它记为「跳过」而不是 OK。手工调用仍是等价入口：

```sh
python3 deploy/tests/nginx-api-boundary.py \
  --config deploy/nginx/harness.nymiro.moe.conf \
  --nginx-image <已有nginx镜像ID> --upstream-image <已有Node镜像ID> \
  --output <仓库外私有验收JSON>
```

测试实际代理注册、记录、状态、撤回、贡献上传及通用/尾斜杠路径，核对授权、JSON 字节和 framing 保留；X-Forwarded-For、X-Real-IP、CF-Connecting-IP、Forwarded、Cookie、User-Agent 和任意自定义请求头不得到达上游。每条 API 访问日志都必须匿名，且不含合成请求头、请求体、查询串或授权值。结果保留配置 SHA 和隔离容器/网络清理状态。

生产只替换 `/docker/nginx-nymiro/conf/harness.nymiro.moe.conf`：先核实际挂载来源和旧 SHA，再保存保持元数据的单文件备份，将已验收的新字节通过同目录临时文件原子替换。执行 `docker exec nginx-nymiro nginx -t` 通过后才 reload；任一步失败，立即从备份原子还原，重新 `nginx -t` 并 reload 原版本。记录旧/新/备份 SHA、语法检查与 reload 结果，不重建服务镜像、不改其他 host 配置，不把写入磁盘成功当作部署完成。
