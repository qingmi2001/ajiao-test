export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const DEFAULT_CONFIG = {
      adminPassword: "admin", // 初始默认管理密码
      token: "mysubtoken123",  // 订阅防盗防扫描 Token
      protocol: "vless",
      uuid: "",
      host: "",
      path: "/",
      port: 443,
      nodePrefix: "CF-优选",
      sources: "https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt",
      staticAddresses: "cloudflare.com\nvisa.cn\nicook.tw"
    };

    // 1. 从 KV 读取持久化配置
    let config = DEFAULT_CONFIG;
    try {
      const stored = await env.SUB_KV.get("CONFIG_DATA");
      if (stored) {
        config = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      }
    } catch (e) {}

    // 辅助函数：校验 Cookie 登录态
    const isAuthed = () => {
      const cookieHeader = request.headers.get("Cookie") || "";
      const cookies = Object.fromEntries(cookieHeader.split(";").map(c => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
      }));
      // 简单 Session 校验（Cookie 内容与密码哈希/一致）
      return cookies["auth_token"] === btoa(encodeURIComponent(config.adminPassword));
    };

    // 2. 路由：登录验证接口 (POST /api/login)
    if (path === "/api/login" && request.method === "POST") {
      try {
        const { password } = await request.json();
        if (password === config.adminPassword) {
          const authToken = btoa(encodeURIComponent(config.adminPassword));
          return new Response(JSON.stringify({ success: true }), {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `auth_token=${authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` // 有效期 7 天
            }
          });
        }
        return new Response(JSON.stringify({ success: false, message: "密码错误" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 3. 路由：退出登录 (GET /logout)
    if (path === "/logout") {
      return new Response("", {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": "auth_token=; Path=/; HttpOnly; Max-Age=0"
        }
      });
    }

    // 4. 路由：保存配置接口 (POST /api/save)
    if (path === "/api/save" && request.method === "POST") {
      if (!isAuthed()) {
        return new Response(JSON.stringify({ success: false, message: "未登录或登录已过期" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const body = await request.json();
        
        // 如果输入了新密码，则更新管理密码并刷新 Cookie
        let newPassword = config.adminPassword;
        let setCookieHeader = null;
        if (body.newPassword && body.newPassword.trim() !== "") {
          newPassword = body.newPassword.trim();
          const authToken = btoa(encodeURIComponent(newPassword));
          setCookieHeader = `auth_token=${authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
        }
        delete body.newPassword;

        const newConfig = { ...config, ...body, adminPassword: newPassword };
        await env.SUB_KV.put("CONFIG_DATA", JSON.stringify(newConfig));

        const resHeaders = { "Content-Type": "application/json" };
        if (setCookieHeader) {
          resHeaders["Set-Cookie"] = setCookieHeader;
        }

        return new Response(JSON.stringify({ success: true }), { headers: resHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 5. 路由：客户端订阅获取接口 (/sub)
    if (path === "/sub") {
      const reqToken = url.searchParams.get("token");
      if (config.token && reqToken !== config.token) {
        return new Response("Unauthorized Token", { status: 403 });
      }

      const sourcesList = (config.sources || "")
        .split("\n")
        .map(s => s.trim())
        .filter(s => s && !s.startsWith("#"));

      let addressList = [];
      for (const src of sourcesList) {
        try {
          const resp = await fetch(src, { headers: { "User-Agent": "CF-Worker" } });
          if (resp.ok) {
            const text = await resp.text();
            const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
            addressList.push(...lines);
          }
        } catch (e) {}
      }

      if (addressList.length === 0) {
        addressList = (config.staticAddresses || "").split("\n").map(l => l.trim()).filter(Boolean);
      }

      const uniqueAddresses = [...new Set(addressList)];
      const format = url.searchParams.get("format") || "raw";

      if (format === "clash") {
        return new Response(generateClashConfig(uniqueAddresses, config), {
          headers: { "Content-Type": "text/yaml; charset=utf-8" }
        });
      }

      const uris = uniqueAddresses.map((entry, index) => {
        let addr = entry;
        let port = config.port;
        let remark = `${config.nodePrefix}-${index + 1}`;

        if (entry.includes("#")) {
          const parts = entry.split("#");
          addr = parts[0];
          remark = `${config.nodePrefix}-${parts[1]}`;
        }
        if (addr.includes(":")) {
          const parts = addr.split(":");
          addr = parts[0];
          port = parts[1];
        }

        const proto = config.protocol || "vless";
        return `${proto}://${config.uuid}@${addr}:${port}?encryption=none&security=tls&sni=${config.host}&type=ws&host=${config.host}&path=${encodeURIComponent(config.path)}#${encodeURIComponent(remark)}`;
      });

      const base64Sub = btoa(unescape(encodeURIComponent(uris.join("\n"))));
      return new Response(base64Sub, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Profile-Update-Interval": "12"
        }
      });
    }

    // 6. 路由：页面访问（未登录展示登录页，已登录展示控制台）
    if (!isAuthed()) {
      return new Response(renderLoginHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    return new Response(renderAdminHTML(config, url.origin), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

function generateClashConfig(addresses, config) {
  const proxies = addresses.map((entry, index) => {
    let addr = entry.split("#")[0].split(":")[0];
    let port = config.port;
    let name = `${config.nodePrefix}-${index + 1}`;
    const proto = config.protocol === "trojan" ? "trojan" : "vless";
    
    if (proto === "trojan") {
      return `  - name: "${name}"\n    type: trojan\n    server: ${addr}\n    port: ${port}\n    password: ${config.uuid}\n    network: ws\n    tls: true\n    sni: ${config.host}\n    ws-opts:\n      path: "${config.path}"\n      headers:\n        Host: ${config.host}`;
    }
    return `  - name: "${name}"\n    type: vless\n    server: ${addr}\n    port: ${port}\n    uuid: ${config.uuid}\n    network: ws\n    tls: true\n    servername: ${config.host}\n    ws-opts:\n      path: "${config.path}"\n      headers:\n        Host: ${config.host}`;
  }).join("\n");
  return `proxies:\n${proxies}`;
}

// 登录页面模板
function renderLoginHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>优选面板 - 登录</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .login-card { background: #fff; padding: 32px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); width: 100%; max-width: 360px; }
    h3 { margin-top: 0; color: #111827; text-align: center; margin-bottom: 20px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; box-sizing: border-box; font-size: 14px; margin-bottom: 16px; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-size: 15px; width: 100%; font-weight: 600; }
    button:hover { background: #1d4ed8; }
    .hint { font-size: 12px; color: #6b7280; text-align: center; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="login-card">
    <h3>管理控制台登录</h3>
    <input type="password" id="pwd" placeholder="请输入管理密码 (默认: admin)" onkeydown="if(event.key==='Enter') doLogin()">
    <button onclick="doLogin()">登 录</button>
    <div class="hint">初始默认管理密码为: admin</div>
  </div>
  <script>
    async function doLogin() {
      const password = document.getElementById('pwd').value;
      if (!password) return alert('请输入密码');
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.success) {
        location.reload();
      } else {
        alert(data.message || '登录失败');
      }
    }
  </script>
</body>
</html>`;
}

// 主管理控制台页面模板
function renderAdminHTML(config, origin) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>优选订阅管理面板</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 20px; }
    .card { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .header-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 15px; }
    h2 { margin: 0; color: #111827; }
    .logout-btn { color: #ef4444; text-decoration: none; font-size: 14px; font-weight: 500; }
    .logout-btn:hover { text-decoration: underline; }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; color: #374151; font-size: 14px; }
    input, textarea, select { width: 100%; padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
    textarea { resize: vertical; height: 75px; }
    .parse-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 12px; margin-bottom: 20px; }
    .btn-parse { background: #2563eb; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 8px; font-weight: 500; }
    .btn-parse:hover { background: #1d4ed8; }
    .btn-save { background: #059669; color: #fff; border: none; padding: 12px 20px; border-radius: 6px; cursor: pointer; font-size: 15px; width: 100%; font-weight: 600; margin-top: 10px; }
    .btn-save:hover { background: #047857; }
    .sub-box { margin-top: 24px; padding: 16px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; }
    .sub-url { word-break: break-all; font-family: monospace; background: #e2e8f0; padding: 6px 10px; border-radius: 4px; display: block; margin-top: 6px; }
    .hint { font-size: 12px; color: #6b7280; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header-bar">
      <h2>节点与优选参数配置</h2>
      <a href="/logout" class="logout-btn">退出登录</a>
    </div>

    <div class="parse-box">
      <label style="color: #1e40af;">快捷导入：直接粘贴完整节点链接 (VLESS / VMess / Trojan)</label>
      <input type="text" id="rawNodeLink" placeholder="vless://... 或 trojan://... 或 vmess://...">
      <button type="button" class="btn-parse" onclick="parseNodeLink()">一键自动解析填入</button>
      <div class="hint">粘贴后点击按钮，将自动提取 UUID/密码、域名、WS路径等信息填入下方。</div>
    </div>

    <div class="form-group">
      <label>修改管理密码 (不修改请留空)</label>
      <input type="password" id="newPassword" placeholder="留空表示不修改当前密码">
    </div>
    <div class="form-group">
      <label>订阅访问 Token (防盗链密钥)</label>
      <input type="text" id="token" value="${config.token || ''}">
    </div>
    <div class="form-group">
      <label>节点协议</label>
      <select id="protocol">
        <option value="vless" ${config.protocol === 'vless' ? 'selected' : ''}>VLESS</option>
        <option value="trojan" ${config.protocol === 'trojan' ? 'selected' : ''}>Trojan</option>
      </select>
    </div>
    <div class="form-group">
      <label>节点 UUID / 密码</label>
      <input type="text" id="uuid" value="${config.uuid || ''}" placeholder="UUID 或连接密码">
    </div>
    <div class="form-group">
      <label>节点域名 Host / SNI (小黄云真实域名)</label>
      <input type="text" id="host" value="${config.host || ''}" placeholder="例如: vps.800721.xyz">
    </div>
    <div class="form-group">
      <label>WS 路径</label>
      <input type="text" id="path" value="${config.path || '/'}" placeholder="/path/wervmsf/">
    </div>
    <div class="form-group">
      <label>TLS 端口</label>
      <input type="number" id="port" value="${config.port || 443}">
    </div>
    <div class="form-group">
      <label>节点名前缀</label>
      <input type="text" id="nodePrefix" value="${config.nodePrefix || 'CF-优选'}">
    </div>
    <div class="form-group">
      <label>在线优选 IP / 域名源 API (一行一个)</label>
      <textarea id="sources">${config.sources || ''}</textarea>
    </div>
    <div class="form-group">
      <label>兜底静态优选域名/IP (一行一个)</label>
      <textarea id="staticAddresses">${config.staticAddresses || ''}</textarea>
    </div>
    <button class="btn-save" onclick="saveData()">保存配置</button>

    <div class="sub-box">
      <strong>通用订阅链接 (V2Ray / Sing-box / Shadowrocket):</strong>
      <span class="sub-url">${origin}/sub?token=${config.token || ''}</span>
      <strong style="margin-top:10px; display:block;">Clash 订阅链接:</strong>
      <span class="sub-url">${origin}/sub?token=${config.token || ''}&format=clash</span>
    </div>
  </div>

  <script>
    function parseNodeLink() {
      const raw = document.getElementById('rawNodeLink').value.trim();
      if (!raw) return alert('请先粘贴节点链接');

      try {
        if (raw.startsWith('vmess://')) {
          const base64Str = raw.replace('vmess://', '');
          const jsonStr = decodeURIComponent(escape(atob(base64Str)));
          const vmess = JSON.parse(jsonStr);
          document.getElementById('protocol').value = 'vless';
          document.getElementById('uuid').value = vmess.id || '';
          document.getElementById('host').value = vmess.host || vmess.sni || vmess.add || '';
          document.getElementById('path').value = vmess.path || '/';
          document.getElementById('port').value = vmess.port || 443;
          alert('VMess 解析成功，已自动填入！');
          return;
        }

        const url = new URL(raw);
        const protocol = url.protocol.replace(':', '').toLowerCase();

        if (protocol === 'vless' || protocol === 'trojan') {
          document.getElementById('protocol').value = protocol;
          document.getElementById('uuid').value = url.username || '';
          document.getElementById('port').value = url.port || 443;
          
          const params = new URLSearchParams(url.search);
          const sni = params.get('sni');
          const host = params.get('host');
          document.getElementById('host').value = host || sni || url.hostname || '';
          document.getElementById('path').value = params.get('path') || '/';
          alert(protocol.toUpperCase() + ' 解析成功，已自动填入！');
        } else {
          alert('不支持的链接协议格式');
        }
      } catch (e) {
        alert('解析失败，请检查链接格式: ' + e.message);
      }
    }

    async function saveData() {
      const data = {
        newPassword: document.getElementById('newPassword').value,
        token: document.getElementById('token').value,
        protocol: document.getElementById('protocol').value,
        uuid: document.getElementById('uuid').value,
        host: document.getElementById('host').value,
        path: document.getElementById('path').value,
        port: parseInt(document.getElementById('port').value) || 443,
        nodePrefix: document.getElementById('nodePrefix').value,
        sources: document.getElementById('sources').value,
        staticAddresses: document.getElementById('staticAddresses').value
      };
      
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (result.success) {
        alert('保存成功！');
        location.reload();
      } else {
        alert('保存失败: ' + (result.message || '未知错误'));
      }
    }
  </script>
</body>
</html>`;
}
