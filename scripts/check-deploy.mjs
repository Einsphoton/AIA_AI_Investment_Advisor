/**
 * Deployment verification (`npm run check:deploy`).
 *
 * Docker is not available in every environment (including some dev machines),
 * so this script proves as much of the deployment story as possible locally:
 *
 *   1. `docker-compose.yml` parses and contains the required wiring
 *   2. `Dockerfile` is multi-stage, runs as non-root, has a healthcheck and
 *      installs dependencies with the same flags used locally
 *   3. `--with-install` additionally reproduces the **runtime dependency
 *      closure**: it installs production-only dependencies into a scratch
 *      directory, copies the built artifacts in exactly like the runtime image
 *      does, boots the server and calls the real API.
 *
 * Usage: node scripts/check-deploy.mjs [--with-install]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withInstall = process.argv.includes('--with-install');
const failures = [];

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/* ───────────────────────────── docker-compose.yml ────────────────────────── */

console.log('\n== docker-compose.yml ==');
const composeText = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
let compose = null;
try {
  compose = parseYaml(composeText);
  check('YAML 可解析', true);
} catch (error) {
  check('YAML 可解析', false, error.message);
}

if (compose) {
  const services = compose.services ?? {};
  const serviceName = Object.keys(services)[0];
  const advisor = services[serviceName] ?? {};
  check('定义了一个服务', Object.keys(services).length === 1, serviceName);
  check('build 指向仓库根 Dockerfile', advisor.build?.context === '.' && advisor.build?.dockerfile === 'Dockerfile');
  check('端口映射存在', Array.isArray(advisor.ports) && advisor.ports.length > 0, JSON.stringify(advisor.ports));
  check('数据卷挂载到 /data', (advisor.volumes ?? []).some((volume) => String(volume).endsWith(':/data')), JSON.stringify(advisor.volumes));
  check('声明了命名卷', Object.keys(compose.volumes ?? {}).length > 0, Object.keys(compose.volumes ?? {}).join(','));
  check('healthcheck 调用 /api/health', JSON.stringify(advisor.healthcheck ?? {}).includes('/api/health'));
  check('restart 策略存在', Boolean(advisor.restart), advisor.restart);
  check('DATA_DIR=/data', advisor.environment?.DATA_DIR === '/data');
  check('LLM 环境变量可外部注入', 'LLM_API_KEY' in (advisor.environment ?? {}) && 'LLM_BASE_URL' in (advisor.environment ?? {}));
  check('日志轮转已配置', Boolean(advisor.logging?.options?.['max-size']));
}

/* ──────────────────────────────── Dockerfile ─────────────────────────────── */

console.log('\n== Dockerfile ==');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
check('多阶段构建（>=4 个 FROM）', (dockerfile.match(/^FROM /gm) ?? []).length >= 4, `${(dockerfile.match(/^FROM /gm) ?? []).length} 个阶段`);
check('非 root 运行', /USER node/.test(dockerfile));
check('存在 HEALTHCHECK', /HEALTHCHECK/.test(dockerfile));
check('声明 VOLUME /data', /VOLUME \["\/data"\]/.test(dockerfile));
check('生产依赖单独安装（--omit=dev）', /npm ci --omit=dev --ignore-scripts/.test(dockerfile));
check('依赖安装跳过生命周期脚本', /npm ci --ignore-scripts/.test(dockerfile));
check('构建阶段执行类型检查门禁', /npm run typecheck/.test(dockerfile));
check('镜像内不打包前端 sourcemap', /AIA_WEB_SOURCEMAP=0/.test(dockerfile) || /sourcemap/i.test(dockerfile));
check('工作区私有 node_modules 被复制', /packages\/server\/node_modules/.test(dockerfile), '@fastify/static 等被 npm 放在 packages/*/node_modules');
check('tini 作为 init 进程', /tini/.test(dockerfile));
check('入口指向构建产物', /packages\/server\/dist\/index\.js/.test(dockerfile));

/* ─────────────────── .dockerignore 不排除构建产物 ────────────────────────── */

console.log('\n== .dockerignore ==');
const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
check('忽略 node_modules', /(^|\n)node_modules/.test(dockerignore));
check('忽略本地数据目录', /(^|\n)data/.test(dockerignore));
check('未忽略源码目录 packages', !/^packages\/?$/m.test(dockerignore) && !/^packages\/\*/m.test(dockerignore.replace(/packages\/\*\/dist\*?/g, '')), '');

/* ─────────────────── 运行时依赖闭包（可选，需要联网） ────────────────────── */

if (withInstall) {
  console.log('\n== 运行时依赖闭包复现（等价于镜像 runtime 阶段）==');
  const scratch = path.join(root, '.runtime-check');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'packages/shared'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'packages/server'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'packages/web'), { recursive: true });

  for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
    fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
  for (const workspace of ['shared', 'server', 'web']) {
    fs.copyFileSync(
      path.join(root, 'packages', workspace, 'package.json'),
      path.join(scratch, 'packages', workspace, 'package.json'),
    );
  }

  const installCode = await new Promise((resolve) => {
    // Single command string avoids Node's "args with shell" deprecation warning.
    const child = spawn('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', {
      cwd: scratch,
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', resolve);
  });
  check('npm ci --omit=dev 成功', installCode === 0, `exit=${installCode}`);

  // Copy built artifacts the same way the runtime stage does.
  const copyDir = (from, to) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  };
  copyDir(path.join(root, 'packages/shared/dist'), path.join(scratch, 'packages/shared/dist'));
  copyDir(path.join(root, 'packages/server/dist'), path.join(scratch, 'packages/server/dist'));
  copyDir(path.join(root, 'packages/web/dist'), path.join(scratch, 'packages/web/dist'));

  check('生产依赖包含 @fastify/static', fs.existsSync(path.join(scratch, 'node_modules/@fastify/static')) || fs.existsSync(path.join(scratch, 'packages/server/node_modules/@fastify/static')));
  check('工作区链接 @aia/shared 存在', fs.existsSync(path.join(scratch, 'node_modules/@aia/shared')));
  check('构建产物已就位', fs.existsSync(path.join(scratch, 'packages/server/dist/index.js')));

  const port = 8898;
  const server = spawn(process.execPath, ['--enable-source-maps', path.join(scratch, 'packages/server/dist/index.js')], {
    cwd: scratch,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(scratch, 'data'), NODE_ENV: 'production', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let healthy = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !healthy) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      healthy = response.ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  check('仅用生产依赖即可启动服务', healthy, healthy ? `http://127.0.0.1:${port}` : '30s 内未就绪');

  if (healthy) {
    const quote = await fetch(`http://127.0.0.1:${port}/api/market/quote?market=CN&code=600519`).then((r) => r.json()).catch(() => null);
    check('生产依赖下行情接口可用', Boolean(quote?.price) && quote.price > 0, `price=${quote?.price}`);
    const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
    check('静态前端可访问（index.html）', page.includes('<div id="root">'));
  }

  try {
    server.kill();
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* sandbox may deny deletion; harmless */
  }
}

console.log(`\n${failures.length === 0 ? '\x1b[32m部署配置检查全部通过\x1b[0m' : `\x1b[31m${failures.length} 项失败：${failures.join('、')}\x1b[0m`}`);
process.exit(failures.length === 0 ? 0 : 1);
