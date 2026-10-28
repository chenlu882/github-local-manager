import { parse as parseToml } from "smol-toml";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { compareVersions, compareCachedVersions } from "./version.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const GIT_CANDIDATES = [process.env.GITHUB_MANAGER_GIT,
  "git",
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe"),
];
const NPM_CANDIDATES = [
  "C:\\Program Files\\nodejs\\npm.cmd",
  "C:\\Program Files\\nodejs\\npm",
  "npm.cmd",
];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function readJson(p) {
  try {
    return JSON.parse(readText(p).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function firstExisting(candidates) {
  return candidates.find((p) => p === "git" || p === "npm.cmd" ? true : exists(p)) || candidates[0];
}

function codexConfig() {
  return readText(CONFIG_PATH);
}

function codexPluginEnabled(id) {
  const text=codexConfig();
  if(!text.trim()) return null;
  try { return parseToml(text).plugins?.[id]?.enabled ?? null; }
  catch { return null; }
}

function githubRepo(pkg) {
  if (!pkg || !pkg.repository) return null;
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
  if (typeof raw !== "string" || !/^(?:git\+)?https?:\/\/github\.com\/|^git@github\.com:/i.test(raw)) return null;
  return raw.replace(/^git\+/, "").replace(/\.git$/, "");
}

function findGit() {
  for (const candidate of [process.env.GITHUB_MANAGER_GIT,...GIT_CANDIDATES].filter(Boolean)) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        windowsHide: true,
        timeout: 5000,
        stdio: "ignore",
      });
      if (result.status === 0) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function findNpm() {
  for (const candidate of NPM_CANDIDATES) {
    if (candidate === "npm.cmd") return candidate;
    if (exists(candidate)) return candidate;
  }
  return "npm.cmd";
}

function toolRoots() {
  const roots = new Set((process.env.GITHUB_MANAGER_NPM_ROOTS || "").split(path.delimiter).filter(Boolean));
  const text = codexConfig();
  const commands = [...text.matchAll(/^\s*command\s*=\s*['"](.+?)['"]\s*$/gm)];
  for (const match of commands) {
    const command = match[1].replace(/\\\\/g, "\\");
    if (command.toLowerCase().endsWith(".exe")) {
      roots.add(path.dirname(command));
    }
  }
  if (process.env.APPDATA) roots.add(path.join(process.env.APPDATA, "npm"));
  return [...roots].filter(
    (root) =>
      exists(path.join(root, "node_modules")) &&
      !/OpenAI[\\/]Codex[\\/]runtimes|Program Files[\\/]nodejs|WindowsApps/i.test(root)
  );
}

function scanTools() {
  const tools = [];
  const seen = new Set();
  const configText = codexConfig().replace(/\\\\/g, "\\");
  for (const root of toolRoots()) {
    const modules = path.join(root, "node_modules");
    const packages = [];
    const entries = fs.readdirSync(modules, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dirs = entry.name.startsWith("@")
        ? fs
            .readdirSync(path.join(modules, entry.name), { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => path.join(modules, entry.name, child.name))
        : [path.join(modules, entry.name)];
      for (const dir of dirs) {
        const pkg = readJson(path.join(dir, "package.json"));
        if (pkg) packages.push({ pkg, dir });
      }
    }

    const referenced = new Set();
    for (const { pkg } of packages) {
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[field] || {})) referenced.add(name);
      }
    }

    for (const { pkg, dir } of packages) {
      if (referenced.has(pkg.name)) continue;
      if (!pkg.bin && pkg.name !== "rea-agents") continue;
      const repo = githubRepo(pkg);
      if (!repo) continue;
      const id = `${root}|${pkg.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const protectedTool =
        pkg.name === "rea-agents" || configText.toLowerCase().includes(dir.toLowerCase()) || configText.toLowerCase().includes(root.toLowerCase());
      tools.push({
        kind: "tool",
        id,
        name: pkg.name,
        version: pkg.version || "",
        repo,
        path: dir,
        root,
        bin: pkg.bin ? Object.keys(pkg.bin)[0] || "" : "",
        protected: protectedTool,
      });
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function scanCodexPlugins() {
  const cache = path.join(CODEX_HOME, "plugins", "cache");
  if (!exists(cache)) return [];
  const out = [];
  for (const marketplace of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const marketplaceDir = path.join(cache, marketplace.name);
    for (const plugin of fs.readdirSync(marketplaceDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(marketplaceDir, plugin.name);
      const versions = fs
        .readdirSync(pluginDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(pluginDir, entry.name))
        .sort((a, b) => compareCachedVersions(path.basename(b), path.basename(a)));
      for (const versionDir of versions) {
        const manifest = readJson(path.join(versionDir, ".codex-plugin", "plugin.json"));
        if (!manifest) continue;
        const id = `${manifest.name || plugin.name}@${marketplace.name}`;
        out.push({
          kind: "codex",
          id,
          name: manifest.name || plugin.name,
          version: manifest.version || path.basename(versionDir),
          description: manifest.description || "",
          repo: manifest.repository || "",
          path: versionDir,
          marketplace: marketplace.name,
          enabled: codexPluginEnabled(id),
          cached: true,
          official: marketplace.name.startsWith("openai-"),
          protected: marketplace.name.startsWith("openai-"),
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const GIT_ROOTS = (process.env.DSH_GITHUB_GIT_ROOTS ? process.env.DSH_GITHUB_GIT_ROOTS.split(path.delimiter) : [
  path.join(HOME, "Desktop"),
  "E:\\项目",
  "D:\\AI",
  "E:\\AI",
]).filter((root) => root && exists(root));

const SKIP_DIRS = new Set([
  "npm-cache",
  ".test-output",
  "node_modules",
  ".git",
  ".next",
  ".cache",
  "AppData",
  "$RECYCLE.BIN",
  "System Volume Information",
  "Program Files",
  "Program Files (x86)",
  "WindowsApps",
]);

function scanGitProjects() {
  const repos = [];
  const seen = new Set();
  function walk(dir, depth) {
    if (depth < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      const dotGit = path.join(dir, ".git");
      const marker = readText(dotGit).match(/^gitdir:\s*(.+)$/m);
      const gitDir = marker ? path.resolve(dir, marker[1].trim()) : dotGit;
      const common = readText(path.join(gitDir, "commondir")).trim();
      const config = readText(path.join(common ? path.resolve(gitDir, common) : gitDir, "config"));
      const url = config.match(/^\s*url\s*=\s*(.+)$/m);
      if (url && /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/(?:git@)?github\.com\/)/i.test(url[1].trim())) {
        if (!seen.has(dir)) {
          seen.add(dir);
          repos.push({
            kind: "git",
            id: dir,
            name: path.basename(dir),
            path: dir,
            repo: url[1].trim(),
            branch: "",
          });
        }
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth - 1);
    }
  }
  for (const root of GIT_ROOTS) walk(root, 6);
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

const DOWNLOAD_ROOTS = (process.env.DSH_GITHUB_DOWNLOAD_ROOTS ? process.env.DSH_GITHUB_DOWNLOAD_ROOTS.split(path.delimiter) : [
  path.join(HOME, "Downloads"),
  "D:\\安装包",
  "E:\\迅雷下载",
]).filter((root) => root && exists(root));

function looksLikeGithubArchive(name) {
  return /(?:^|[-_.])(main|master)\.zip$/i.test(name) || /github/i.test(name);
}

function looksLikeGithubDirectory(dir) {
  if (exists(path.join(dir, ".github"))) return true;
  const pkg = readJson(path.join(dir, "package.json"));
  return Boolean(pkg && githubRepo(pkg));
}

function scanDownloads() {
  const out = [];
  for (const root of DOWNLOAD_ROOTS) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isFile() && /\.(zip|7z|rar|tar\.gz|tgz)$/i.test(entry.name)) {
        if (!looksLikeGithubArchive(entry.name)) continue;
        const stat = fs.statSync(full);
        out.push({
          kind: "download",
          id: full,
          name: entry.name,
          path: full,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      } else if (entry.isDirectory()) {
        if (exists(path.join(full, ".git"))) continue;
        if (!looksLikeGithubDirectory(full)) continue;
        out.push({
          kind: "download",
          id: full,
          name: entry.name,
          path: full,
          size: 0,
          modified: "",
        });
      }
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 80);
}

export function scanState() {
  const errors = {};
  const scan = (key, fn) => { try { return fn(); } catch (error) { errors[key] = error.message; return []; } };
  return {
    tools: scan("tools", scanTools), codex: scan("codex", scanCodexPlugins),
    git: scan("git", scanGitProjects), downloads: scan("downloads", scanDownloads),
    errors, capabilities: { git: Boolean(findGit()), npm: Boolean(npmCliPath(findNpm())) },
    scanRoots: { git: GIT_ROOTS, downloads: DOWNLOAD_ROOTS },
  };
}

let cachedState, scanPromise;
let cacheTime = 0;
const scanWorkers = new Set();
export async function state(force = false) {
  if (scanPromise) return scanPromise;
  if (!force && cachedState && Date.now() - cacheTime < 15000) return cachedState;
  scanPromise = new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./scan-worker.js', import.meta.url), { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    scanWorkers.add(worker);
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('扫描超时，请缩小扫描目录后重试')); }, 30000);
    worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.value));
    worker.once('error', reject);
    worker.once('exit', code => { clearTimeout(timer); scanWorkers.delete(worker); if(code !== 0) reject(new Error('扫描进程已结束')); });
  }).then(value => { cachedState = value; cacheTime = Date.now(); return value; }).finally(() => { scanPromise = null; });
  return scanPromise;
}

async function openPath(target) {
  if (!exists(target)) throw new Error("路径不存在");

  try {
    const electron = await import("electron");
    const shell = electron.shell || (electron.default && electron.default.shell);
    if (shell && typeof shell.showItemInFolder === "function") {
      shell.showItemInFolder(target);
      return "已在资源管理器中显示";
    }
    if (shell && typeof shell.openPath === "function") {
      const error = await shell.openPath(target);
      if (!error) return "已打开位置";
    }
  } catch {
    // Not running under Electron; use the Windows shell fallback.
  }

  const explorer = "C:\\Windows\\explorer.exe";
  await new Promise((resolve, reject) => {
    const child = spawn(explorer, [`/select,${target}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return "已请求在资源管理器中显示";
}

export async function runCommand(command, args, options = {}) {
  if (typeof command !== 'string' || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('命令参数无效');
  let executable = command, argv = args;
  if (/npm(?:\.cmd)?$/i.test(command)) {
    const cli = npmCliPath(command);
    if (!cli) throw new Error('找不到 npm-cli.js，请安装完整的 Node.js / npm 后重试');
    executable = process.execPath;
    argv = [cli, ...args];
  }
  try {
    const result = await execFileAsync(executable, argv, {
      windowsHide: true, shell: false, timeout: options.timeout || 120000,
      maxBuffer: 1024 * 1024 * 8,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    });
    // npm JSON is on stdout; warnings on stderr must not corrupt it.
    return (result.stdout || result.stderr || '').trim();
  } catch (error) { throw new Error(((error.stdout || '') + (error.stderr || '')).trim() || error.message); }
}

function npmCliPath(command) {
  const dirs = [path.dirname(command), ...String(process.env.PATH || '').split(path.delimiter)];
  return dirs.flatMap(dir => [path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, 'npm/bin/npm-cli.js')]).find(exists);
}

async function checkTool(id) {
  const tool = (await state()).tools.find((item) => item.id === id);
  if (!tool) throw new Error("找不到工具");
  const npm = findNpm();
  const output = await runCommand(
    npm,
    ["view", tool.name, "version", "--json", "--no-audit", "--no-fund"],
    { timeout: 60000 }
  );
  let latest;
  try {
    const parsed = JSON.parse(output);
    latest = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  } catch {
    latest = output.split(/\r?\n/).filter(Boolean).pop();
  }
  latest = String(latest || "").replace(/^v/i, "").trim();
  if (!latest) throw new Error("没有从 npm 得到最新版本");
  return {
    source: "npm",
    current: tool.version,
    latest,
    hasUpdate: compareVersions(latest, tool.version) > 0,
  };
}

async function checkGit(id) {
  const git = findGit();
  if (!git) throw new Error('没有找到 git，请先安装 Git for Windows');
  const repo = (await state()).git.find(item => item.id === id);
  if (!repo) throw new Error('找不到仓库');
  const run = args => runCommand(git, ['-C', repo.path, ...args]);
  const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (!branch) throw new Error('当前处于游离 HEAD，请先切换到需要更新的分支');
  if (await run(['status', '--porcelain'])) throw new Error('仓库有未提交或未跟踪的文件，请先提交或暂存后再更新');
  const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
  if (!upstream) throw new Error('当前分支未设置跟踪分支，请先在 Git 中设置上游');
  await run(['fetch', '--quiet']);
  const currentFull = await run(['rev-parse', 'HEAD']);
  const latestFull = await run(['rev-parse', '@{u}']);
  const [ahead, behind] = (await run(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) throw new Error('无法判断分支状态');
  if (ahead && behind) throw new Error('本地与上游分支已分叉，请先在 Git 中处理后再更新');
  return { source: 'git', current: currentFull.slice(0,7), latest: latestFull.slice(0,7),
    currentFull, latestFull, branch, upstream, ahead, commits: behind, hasUpdate: behind > 0 };
}

const locks = new Set();
const updateTickets = new Map();
export async function withLock(key, task) {
  if (locks.has(key)) throw new Error('该项目正在处理中，请等待完成');
  locks.add(key);
  try { return await task(); } finally { locks.delete(key); }
}
function rememberCheck(type, id, result) {
  for (const [key, value] of updateTickets) if (Date.now() - value.at > 600000) updateTickets.delete(key);
  if (!result.hasUpdate) return result;
  const ticket = randomUUID();
  updateTickets.set(ticket, { type, id, result, at: Date.now() });
  return { ...result, ticket };
}
function consumeCheck(type, id, ticket) {
  const checked = updateTickets.get(ticket);
  updateTickets.delete(ticket);
  if (!checked || checked.type !== type || checked.id !== id || Date.now() - checked.at > 600000) throw new Error('更新确认已失效，请重新检查更新');
  return checked.result;
}

export async function check(body) {
  const { type, id } = body || {};
  if (!type || !id) throw new Error("参数不完整");
  if (type === "tool") return rememberCheck(type, id, await checkTool(id));
  if (type === "git") return rememberCheck(type, id, await checkGit(id));
  throw new Error(`不支持检查: ${type}`);
}

export async function action(body) {
  const { type, id, action: verb, ticket } = body || {};
  if (!type || !id || !verb) throw new Error("参数不完整");

  if (verb === "open") {
    let target = id;
    if (type === "tool") {
      const tool = (await state()).tools.find((item) => item.id === id);
      if (!tool) throw new Error("找不到工具");
      target = tool.path;
    } else if (type === "codex") {
      const plugin = (await state()).codex.find((item) => item.id === id);
      if (!plugin) throw new Error("找不到 Codex 插件");
      target = plugin.path;
    } else if (type === "git") {
      const repo = (await state()).git.find((item) => item.id === id);
      if (!repo) throw new Error("找不到仓库");
      target = repo.path;
    } else if (type === "download") {
      const item = (await state()).downloads.find((entry) => entry.id === id);
      if (!item) throw new Error("找不到下载项");
      target = item.path;
    }
    if (!["tool", "codex", "git", "download"].includes(type)) throw new Error("不支持的类型");
    return await openPath(target);
  }

  if (type === "tool") {
    const tool = (await state(true)).tools.find((item) => item.id === id);
    if (!tool) throw new Error("找不到工具");
    if (verb === "uninstall" && tool.protected) {
      throw new Error("这个工具被 Codex 配置引用，已禁止卸载；请先移除 Codex MCP 配置");
    }
    const npm = findNpm();
    if (verb === "update") {
      const checked = consumeCheck(type, id, ticket);
      if (tool.version !== checked.current) throw new Error("已安装版本发生变化，请重新检查");
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(tool.name) || tool.name.startsWith("-")) throw new Error("npm 包名无效");
      return await runCommand(npm, ["install", "--global", "--prefix", tool.root, `${tool.name}@${checked.latest}`, "--no-audit", "--no-fund"], {
        timeout: 300000,
      });
    }
    if (verb === "uninstall") {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(tool.name) || tool.name.startsWith("-")) throw new Error("npm 包名无效");
      return await runCommand(npm, ["uninstall", "--global", "--prefix", tool.root, tool.name], {
        timeout: 300000,
      });
    }
  }


  if (type === "git" && verb === "update") {
    const git = findGit();
    if (!git) throw new Error("没有找到 git，可先安装 Git for Windows");
    const repo = (await state()).git.find((item) => item.id === id);
    if (!repo) throw new Error("找不到仓库");
    const checked = consumeCheck(type, id, ticket);
    const next = await checkGit(id);
    if (next.currentFull !== checked.currentFull || next.latestFull !== checked.latestFull || next.branch !== checked.branch || next.upstream !== checked.upstream) throw new Error('分支或上游提交发生变化，请重新检查更新');
    return await runCommand(git, ['-C', repo.path, 'merge', '--ff-only', checked.latestFull], { timeout: 180000 });
  }

  throw new Error(`不支持的操作: ${type}/${verb}`);
}

export async function dispose() {
  await Promise.all([...scanWorkers].map(worker => worker.terminate()));
}
export function invalidate(){cachedState=undefined;cacheTime=0;}
export function environmentStatus(){return {git:Boolean(findGit()),npm:Boolean(npmCliPath(findNpm()))};}
