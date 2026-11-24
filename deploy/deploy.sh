#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?用法: ./deploy/deploy.sh <镜像标签>}"
SSH_HOST="${SSH_HOST:-root@45.207.215.102}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_biliboard}"
DEPLOY_DIR="/srv/storage/nameless-worksheet"
IMAGE_REPO="ghcr.io/1zero224/nameless-worksheet"

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 1. 确认部署目录存在并同步 compose.yaml"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" "test -d '$DEPLOY_DIR' && test -f '$DEPLOY_DIR/.env'"
scp "${SSH_OPTS[@]}" "$SCRIPT_DIR/compose.yaml" "$SSH_HOST:$DEPLOY_DIR/compose.yaml"

echo "==> 2. 检查系统盘剩余空间（要求 >= 2 GB）"
AVAIL_KB="$(ssh "${SSH_OPTS[@]}" "$SSH_HOST" "df -k / | awk 'NR==2 {print \$4}'")"
if [ "$AVAIL_KB" -lt 2097152 ]; then
  echo "错误：系统盘 / 剩余空间不足 2 GB（当前 ${AVAIL_KB} KB），中止部署" >&2
  exit 1
fi

echo "==> 3. 拉取镜像并执行迁移与上线（tag=${TAG}）"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s -- "$DEPLOY_DIR" "$TAG" "$IMAGE_REPO" <<'EOF'
set -euo pipefail
DEPLOY_DIR="$1"
NEW_TAG="$2"
IMAGE_REPO="$3"
cd "$DEPLOY_DIR"

OLD_TAG="$(grep -E '^APP_IMAGE_TAG=' .env | head -n1 | cut -d= -f2- || echo latest)"

set_tag() {
  local tag="$1"
  if grep -qE '^APP_IMAGE_TAG=' .env; then
    sed -i "s|^APP_IMAGE_TAG=.*|APP_IMAGE_TAG=${tag}|" .env
  else
    printf '\nAPP_IMAGE_TAG=%s\n' "$tag" >> .env
  fi
}

set_tag "$NEW_TAG"
docker compose pull app
docker compose up -d db
docker compose run --rm app node dist/cli.js migrate
docker compose up -d app

echo "等待健康检查通过..."
HEALTHY=0
for i in $(seq 1 30); do
  if curl -fsS http://172.19.0.1:18610/api/health >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 2
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "健康检查失败，回滚到 ${OLD_TAG}" >&2
  set_tag "$OLD_TAG"
  docker compose up -d app
  exit 1
fi

echo "清理旧镜像（保留最近 3 个）..."
OLD_IDS="$(docker images "$IMAGE_REPO" --format '{{.ID}} {{.CreatedAt}}' | awk '!seen[$1]++' | tail -n +4 | awk '{print $1}')"
if [ -n "$OLD_IDS" ]; then
  echo "$OLD_IDS" | xargs -r docker rmi || true
fi
echo "部署成功：${IMAGE_REPO}:${NEW_TAG}"
EOF
