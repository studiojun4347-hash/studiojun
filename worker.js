// ===================================================
// STUDIOJUN v5.0 Production Management - Cloudflare Worker API
// [v5.14.36] +Workflow Engine API (2026-05-18)
// [v5.14.35] +Slack Events API webhook (2026-05-17)
// [v5.14.28] +Higgsfield jobs API (2026-05-06)
// ===================================================

const WORKER_VERSION = 'v5.14.45-slack-heygen';
const DEFAULT_FIREBASE_PROJECT_ID = 'project-f82ebca6-a38b-4d53-94e';

export default {
  // ===== Cron Scheduled Handler =====
  // Morning briefing: 00:00 UTC / 09:00 KST
  // Afternoon check: 09:00 UTC / 18:00 KST
  // Weekly report: Friday 01:00 UTC / 10:00 KST
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`[CRON] Triggered: ${cron} at ${new Date().toISOString()}`);
    try {
      if (cron === '0 0 * * *') {
        await sendScheduledBriefing(env, 'morning');
      } else if (cron === '0 9 * * *') {
        await sendScheduledBriefing(env, 'afternoon');
      } else if (cron === '0 1 * * 5') {
        await sendScheduledBriefing(env, 'weekly');
      }
    } catch (e) {
      console.error('[CRON] Error:', e.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    try {
      const adminGate = await requireAdminForPath(path, request, env);
      if (adminGate) return addCors(adminGate, request, env);

      // Admin: R2?먯꽌 ?꾨줎?몄뿏??諛고룷 (?먮룞?붿슜)
      if (path === '/admin/deploy-from-r2' && request.method === 'POST') {
        const { r2Key } = await request.json();
        const obj = await env.ASSETS.get(r2Key || 'deploy/frontend.html');
        if (!obj) return addCors(json({ error: 'Not found in R2', key: r2Key || 'deploy/frontend.html' }, 404));
        const html = await obj.text();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO static_pages (key, content_type, content) VALUES ('/', 'text/html', ?)"
        ).bind(html).run();
        return addCors(json({ success: true, length: html.length, source: r2Key || 'deploy/frontend.html' }));
      }

      // Admin: URL?먯꽌 ?꾨줎?몄뿏??諛고룷 (?먮룞?붿슜)
      if (path === '/admin/deploy-from-url' && request.method === 'POST') {
        const { url } = await request.json();
        if (!url) return addCors(json({ error: 'url required' }, 400));
        if (!isAllowedDeploySourceUrl(url)) return addCors(json({ error: 'URL origin is not allowed' }, 400));
        const resp = await fetch(url);
        if (!resp.ok) return addCors(json({ error: 'Fetch failed', status: resp.status }, 502));
        const html = await resp.text();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO static_pages (key, content_type, content) VALUES ('/', 'text/html', ?)"
        ).bind(html).run();
        return addCors(json({ success: true, length: html.length, source: url }));
      }

      // Admin: HTML ?낅줈??(key 吏??媛??
      if (path === '/admin/upload-html' && request.method === 'POST') {
        const { key, content } = await request.json();
        const pageKey = key || '/';
        await env.DB.prepare(
          "INSERT OR REPLACE INTO static_pages (key, content_type, content) VALUES (?, 'text/html', ?)"
        ).bind(pageKey, content).run();
        return addCors(json({ success: true, key: pageKey, length: content.length }));
      }

      // Admin: chunk upload
      if (path === '/admin/chunk' && request.method === 'POST') {
        const { mode, data, page: pageParam } = await request.json(); const key = pageParam || '/';
        if (mode === 'init') {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO static_pages (key, content_type, content) VALUES (?, 'text/html', ?)"
          ).bind(key, data || '').run();
          return addCors(json({ success: true, mode: 'init' }));
        } else if (mode === 'append') {
          await env.DB.prepare(
            "UPDATE static_pages SET content = content || ? WHERE key = ?"
          ).bind(data, key).run();
          return addCors(json({ success: true, mode: 'append' }));
        } else if (mode === 'length') {
          const row = await env.DB.prepare(
            "SELECT length(content) as len FROM static_pages WHERE key = ?"
          ).bind(key).first();
          return addCors(json({ success: true, length: row?.len || 0 }));
        }
        return addCors(json({ error: 'invalid mode' }, 400));
      }

      // Admin: R2 紐⑤뱢 ?낅줈??(SPA 紐⑤뱢 諛고룷??
      if (path === '/admin/upload-r2' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        const key = formData.get('key');
        if (!file || !key) return addCors(json({ error: 'file and key required' }, 400));
        if (!isAllowedR2UploadKey(String(key))) return addCors(json({ error: 'R2 key prefix is not allowed' }, 400));
        await env.ASSETS.put(key, file, {
          httpMetadata: { contentType: file.type || 'application/javascript' }
        });
        return addCors(json({ success: true, key, size: file.size }));
      }

      // Admin: Bulk SQL seed (for D1 data initialization)
      if (path === '/admin/seed' && request.method === 'POST') {
        const { sql, statements } = await request.json();
        try {
          if (statements && Array.isArray(statements)) {
            const invalid = statements.find(s => !isAllowedSeedSql(s));
            if (invalid) return addCors(json({ error: 'Disallowed SQL statement for admin seed' }, 400));
            // Execute multiple statements in a batch
            const stmts = statements.map(s => env.DB.prepare(s));
            const results = await env.DB.batch(stmts);
            return addCors(json({ success: true, count: results.length }));
          } else if (sql) {
            if (!isAllowedSeedSql(sql)) return addCors(json({ error: 'Disallowed SQL statement for admin seed' }, 400));
            const result = await env.DB.prepare(sql).run();
            return addCors(json({ success: true, changes: result.meta?.changes }));
          }
          return addCors(json({ error: 'provide sql or statements' }, 400));
        } catch(e) {
          return addCors(json({ error: e.message }, 500));
        }
      }

      // Admin: D1 staging ??static_pages ?꾨줎?몄뿏??諛고룷
      // POST /admin/deploy-frontend?key=sjdeploy_2026&page=/
      if ((path === '/admin/deploy-frontend' || path === '/api/admin/deploy-frontend') && request.method === 'POST') {
        const auth = await requireAdmin(request, env);
        if (!auth) return addCors(json({ error: 'Unauthorized' }, 401));
        try {
          const rows = await env.DB.prepare('SELECT content FROM deploy_staging ORDER BY chunk_idx ASC').all();
          if (!rows.results || rows.results.length === 0) return addCors(json({ error: 'deploy_staging is empty' }, 400));
          const html = rows.results.map(r => r.content).join('');
          if (html.length < 100) return addCors(json({ error: 'Content too short: ' + html.length }, 400));
          const pageKey = new URL(request.url).searchParams.get('page') || '/';
          await env.DB.prepare(
            "INSERT OR REPLACE INTO static_pages (key, content_type, content) VALUES (?, 'text/html', ?)"
          ).bind(pageKey, html).run();
          await env.DB.prepare('DELETE FROM deploy_staging').run();
          return addCors(json({ success: true, page: pageKey, content_length: html.length, chunks: rows.results.length }));
        } catch(e) { return addCors(json({ error: e.message }, 500)); }
      }

      // Admin: D1 staging 湲곕컲 ??꾨같??      // POST /admin/deploy-self?key=sjdeploy_2026
      if ((path === '/api/admin/deploy-self' || path === '/admin/deploy-self') && request.method === 'POST') {
        const auth = await requireAdmin(request, env, { adminOnly: true });
        if (!auth) return addCors(json({ error: 'Unauthorized' }, 401));
        const confirm = requireDeployConfirm(request);
        if (confirm) return addCors(confirm);
        try {
          const rows = await env.DB.prepare('SELECT content FROM deploy_staging ORDER BY chunk_idx ASC').all();
          if (!rows.results || rows.results.length === 0) return addCors(json({ error: 'deploy_staging is empty' }, 400));
          const code = rows.results.map(r => r.content).join('');
          if (code.length < 1000) return addCors(json({ error: 'Code too short: ' + code.length }, 400));
          const accountId = '11672bfed94bba41cc2b50f8d8b62e10';
          const scriptName = 'studiojun';
          const apiToken = env.CF_API_TOKEN;
          if (!apiToken) return addCors(json({ error: 'CF_API_TOKEN secret is not configured' }, 500));
          const metadata = JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-11-01', keep_bindings: ['secret_text'], bindings: [{ type: 'd1', name: 'DB', id: 'ad5676f4-c5a6-48c6-8263-f988fbc68330' }, { type: 'r2_bucket', name: 'ASSETS', bucket_name: 'studiojun-assets' }] });
          const boundary = '----SJDeploy' + Date.now();
          const body2 = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${code}\r\n--${boundary}--`;
          const cfResp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, { method: 'PUT', headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: body2 });
          const cfResult = await cfResp.json();
          if (!cfResp.ok) return addCors(json({ error: 'CF API error', detail: cfResult }, 502));
          await env.DB.prepare('DELETE FROM deploy_staging').run();
          return addCors(json({ success: true, code_size: code.length, chunks: rows.results.length, cf: cfResult?.result?.id || 'deployed' }));
        } catch(e) { return addCors(json({ error: e.message }, 500)); }
      }

      // Admin: Worker ??꾨같????R2??肄붾뱶 ?낅줈????CF API濡??먮룞 諛고룷
      // Step 1: POST /admin/deploy-worker/upload ??肄붾뱶瑜?R2?????
      if (path === '/admin/deploy-worker/upload' && request.method === 'POST') {
        const code = await request.text();
        if (!code || code.length < 100) return addCors(json({ error: 'Code too short' }, 400));
        await env.ASSETS.put('deploy/worker.js', code, { httpMetadata: { contentType: 'application/javascript' } });
        return addCors(json({ success: true, size: code.length, stored: 'deploy/worker.js' }));
      }

      // Step 2: POST /admin/deploy-worker/execute ??R2?먯꽌 肄붾뱶瑜??쎌뼱 CF API濡?諛고룷
      if (path === '/admin/deploy-worker/execute' && request.method === 'POST') {
        const confirm = requireDeployConfirm(request);
        if (confirm) return addCors(confirm);
        try {
          // R2?먯꽌 肄붾뱶 ?쎄린
          const obj = await env.ASSETS.get('deploy/worker.js');
          if (!obj) return addCors(json({ error: 'No code in R2. Upload first via /admin/deploy-worker/upload' }, 404));
          const code = await obj.text();

          // CF API 諛고룷 ?ㅼ젙
          const accountId = '11672bfed94bba41cc2b50f8d8b62e10';
          const scriptName = 'studiojun';
          const apiToken = env.CF_API_TOKEN;
          if (!apiToken) return addCors(json({ error: 'CF_API_TOKEN secret is not configured' }, 500));

          const metadata = JSON.stringify({
            main_module: 'worker.js',
            compatibility_date: '2024-11-01',
            keep_bindings: ['secret_text'],
            bindings: [
              { type: 'd1', name: 'DB', id: 'ad5676f4-c5a6-48c6-8263-f988fbc68330' },
              { type: 'r2_bucket', name: 'ASSETS', bucket_name: 'studiojun-assets' }
            ]
          });

          const boundary = '----WorkerDeploy' + Date.now();
          const body = [
            `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}`,
            `--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${code}`,
            `--${boundary}--`
          ].join('\r\n');

          const resp = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
              },
              body: body
            }
          );

          const result = await resp.json();
          if (result.success) {
            // 諛고룷 ?깃났 濡쒓렇
            await env.DB.prepare(
              "INSERT INTO notifications (user_id, type, title, body) VALUES (1, 'system', 'Worker 諛고룷 ?꾨즺', ?)"
            ).bind(`?먮룞諛고룷 ?꾨즺: ${code.length} bytes, ${result.result?.modified_on || 'ok'}`).run();

            return addCors(json({
              success: true,
              size: code.length,
              modified_on: result.result?.modified_on,
              message: 'Worker deployed successfully'
            }));
          } else {
            return addCors(json({ success: false, errors: result.errors }, 500));
          }
        } catch (e) {
          return addCors(json({ error: e.message }, 500));
        }
      }

      // Admin: R2 紐⑤뱢 ?낅줈????POST /admin/upload-module?name=xxx.js&key=sjdeploy_2026
      // Chrome MCP?먯꽌 JS 肄붾뱶瑜?吏곸젒 R2 modules/ 寃쎈줈???낅줈??
      if ((path === '/admin/upload-module' || path === '/api/admin/upload-module') && request.method === 'POST') {
        const auth = await requireAdmin(request, env);
        if (!auth) return addCors(json({ error: 'Unauthorized' }, 401));
        const moduleName = new URL(request.url).searchParams.get('name');
        if (!moduleName || !moduleName.endsWith('.js')) return addCors(json({ error: 'name parameter required (e.g. name=ai-studio.js)' }, 400));
        try {
          const code = await request.text();
          if (!code || code.length < 10) return addCors(json({ error: 'Module code too short' }, 400));
          const r2Key = `modules/${moduleName}`;
          await env.ASSETS.put(r2Key, code, { httpMetadata: { contentType: 'application/javascript; charset=utf-8' } });
          return addCors(json({ success: true, module: moduleName, r2_key: r2Key, size: code.length }));
        } catch(e) { return addCors(json({ error: e.message }, 500)); }
      }

      // Admin: D1 module_staging ??R2 紐⑤뱢 諛고룷 (?κ린 ?덉젙 ?뚯씠?꾨씪??
      // POST /admin/deploy-module-from-d1?key=sjdeploy_2026 ???꾩껜 諛고룷
      // POST /admin/deploy-module-from-d1?name=xxx.js&key=sjdeploy_2026 ???⑥씪 紐⑤뱢
      // ?먮쫫: Dispatch媛 D1 MCP濡?module_staging??base64 ????????붾뱶?ъ씤???몃━嫄???R2 ?낅줈??
      if ((path === '/admin/deploy-module-from-d1' || path === '/api/admin/deploy-module-from-d1') && request.method === 'POST') {
        const auth = await requireAdmin(request, env);
        if (!auth) return addCors(json({ error: 'Unauthorized' }, 401));
        try {
          const targetName = new URL(request.url).searchParams.get('name');
          let rows;
          if (targetName) {
            rows = await env.DB.prepare('SELECT name, b64 FROM module_staging WHERE name = ?').bind(targetName).all();
          } else {
            rows = await env.DB.prepare('SELECT name, b64 FROM module_staging ORDER BY name').all();
          }
          if (!rows.results || rows.results.length === 0) {
            return addCors(json({ error: 'module_staging is empty' + (targetName ? ` for ${targetName}` : '') }, 400));
          }
          const deployed = [];
          for (const row of rows.results) {
            const jsCode = atob(row.b64);
            const r2Key = `modules/${row.name}`;
            await env.ASSETS.put(r2Key, jsCode, {
              httpMetadata: { contentType: 'application/javascript; charset=utf-8' }
            });
            deployed.push({ name: row.name, r2_key: r2Key, size: jsCode.length });
            await env.DB.prepare('DELETE FROM module_staging WHERE name = ?').bind(row.name).run();
          }
          return addCors(json({ success: true, deployed, count: deployed.length }));
        } catch(e) { return addCors(json({ error: e.message }, 500)); }
      }

      // Admin: R2 紐⑤뱢 紐⑸줉 議고쉶 ??GET /admin/list-modules?key=sjdeploy_2026
      if ((path === '/admin/list-modules' || path === '/api/admin/list-modules') && request.method === 'GET') {
        const auth = await requireAdmin(request, env);
        if (!auth) return addCors(json({ error: 'Unauthorized' }, 401));
        try {
          const list = await env.ASSETS.list({ prefix: 'modules/' });
          const modules = list.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
          return addCors(json({ modules, count: modules.length }));
        } catch(e) { return addCors(json({ error: e.message }, 500)); }
      }

      // Combo: POST /admin/deploy-worker ???먯뒪??諛고룷 (肄붾뱶 ?낅줈??+ 利됱떆 諛고룷)
      if (path === '/admin/deploy-worker' && request.method === 'POST') {
        const confirm = requireDeployConfirm(request);
        if (confirm) return addCors(confirm);
        try {
          const code = await request.text();
          if (!code || code.length < 100) return addCors(json({ error: 'Code too short' }, 400));

          // R2 諛깆뾽
          await env.ASSETS.put('deploy/worker.js', code, { httpMetadata: { contentType: 'application/javascript' } });
          await env.ASSETS.put(`deploy/worker-backup-${Date.now()}.js`, code, { httpMetadata: { contentType: 'application/javascript' } });

          // CF API 諛고룷
          const accountId = '11672bfed94bba41cc2b50f8d8b62e10';
          const scriptName = 'studiojun';
          const apiToken = env.CF_API_TOKEN;
          if (!apiToken) return addCors(json({ error: 'CF_API_TOKEN secret is not configured' }, 500));

          const metadata = JSON.stringify({
            main_module: 'worker.js',
            compatibility_date: '2024-11-01',
            keep_bindings: ['secret_text'],
            bindings: [
              { type: 'd1', name: 'DB', id: 'ad5676f4-c5a6-48c6-8263-f988fbc68330' },
              { type: 'r2_bucket', name: 'ASSETS', bucket_name: 'studiojun-assets' }
            ]
          });

          const boundary = '----WorkerDeploy' + Date.now();
          const body = [
            `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}`,
            `--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${code}`,
            `--${boundary}--`
          ].join('\r\n');

          const resp = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
              },
              body: body
            }
          );

          const result = await resp.json();
          if (result.success) {
            await env.DB.prepare(
              "INSERT INTO notifications (user_id, type, title, body) VALUES (1, 'system', 'Worker ?먮룞諛고룷', ?)"
            ).bind(`${code.length} bytes deployed at ${result.result?.modified_on || new Date().toISOString()}`).run();

            return addCors(json({
              success: true,
              size: code.length,
              modified_on: result.result?.modified_on,
              message: 'Worker deployed successfully via self-deploy'
            }));
          } else {
            return addCors(json({ success: false, errors: result.errors }, 500));
          }
        } catch (e) {
          return addCors(json({ error: e.message }, 500));
        }
      }

      // AI ?붾뱶?ъ씤??
      if (path.startsWith('/ai/')) {
        const res = await handleAI(path, request, env);
        return addCors(res);
      }

      // R2 誘몃뵒???붾뱶?ъ씤??
      if (path.startsWith('/r2/')) {
        const res = await handleR2(path, request, env);
        return addCors(res);
      }

      // 媛?대뱶 鍮꾨뵒??泥섎━ API (Whisper STT + Claude ?붿빟/踰덉뿭)
      if (path.startsWith('/api/guide/')) {
        const res = await handleGuideAPI(path, request, env);
        return addCors(res);
      }

      // HeyGen Video Translate API
      if (path.startsWith('/api/heygen/')) {
        const res = await handleHeyGenAPI(path, request, env);
        return addCors(res);
      }

      // Storyboard 由щ럭 API
      if (path.startsWith('/api/storyboard/')) {
        const res = await handleStoryboardAPI(path, request, env);
        return addCors(res);
      }

      // Seedance 2.0 AI ?뚮뜑留?API
      if (path.startsWith('/api/seedance/')) {
        if (path === '/api/seedance/config') {
          const seedanceConfigAuth = await requireAdmin(request, env);
          if (!seedanceConfigAuth) return addCors(json({ error: 'Unauthorized' }, 401), request, env);
        }
        const res = await handleSeedanceAPI(path, request, env);
        return addCors(res);
      }

      // GPT Image 2 API
      if (path.startsWith('/api/gpt-image/')) {
        const res = await handleGPTImageAPI(path, request, env);
        return addCors(res);
      }

      // Workflow Engine API (Morphic-style)
      if (path.startsWith('/api/workflows/')) {
        const wfUser = await authenticateAny(request, env);
        if (!wfUser) return addCors(json({ error: 'Unauthorized' }, 401));
        const res = await handleWorkflowAPI(path, request, env);
        return addCors(res);
      }

      // Higgsfield AI Studio job history API
      if (path.startsWith('/api/higgsfield/')) {
        const res = await handleHiggsfieldAPI(path, request, env);
        return addCors(res);
      }

      // 踰꾩쟾 API
      if (path === '/api/version') {
        return addCors(json({ version: WORKER_VERSION, worker: 'studiojun' }));
      }

      // ?대찓??諛쒖넚 API (MailChannels)
      if (path === '/api/email/send' && request.method === 'POST') {
        const user = await authenticateAny(request, env);
        if (!user || (user.role !== 'admin' && user.role !== 'pd')) return addCors(json({ error: 'Admin/PD only' }, 403));
        const { to, to_name, subject, body, reply_to } = await request.json();
        if (!to || !subject || !body) return addCors(json({ error: 'to, subject, body required' }, 400));
        try {
          const mailRes = await fetch('https://api.mailchannels.net/tx/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to, name: to_name || to }] }],
              from: { email: 'noreply@studiojun.co.kr', name: 'STUDIOJUN' },
              reply_to: { email: reply_to || 'studiojun4347@gmail.com', name: 'JUN' },
              subject: subject,
              content: [{ type: 'text/plain', value: body }]
            })
          });
          if (mailRes.ok || mailRes.status === 202) {
            return addCors(json({ success: true, status: mailRes.status }));
          }
          const errText = await mailRes.text();
          return addCors(json({ error: 'MailChannels error', status: mailRes.status, detail: errText }, 502));
        } catch(e) {
          return addCors(json({ error: e.message }, 500));
        }
      }

      // Google Sheets ?곕룞 API (?몄쬆 ?꾩닔)
      if (path.startsWith('/api/sheets/')) {
        const sheetsUser = await authenticateAny(request, env);
        if (!sheetsUser) return addCors(json({ error: 'Unauthorized' }, 401));
        // writeback-config??admin/pd ?꾩슜
        if (path === '/api/sheets/writeback-config' || path === '/api/sheets/config') {
          const sheetsRole = String(sheetsUser.role || '').toLowerCase();
          if (sheetsRole !== 'admin' && sheetsRole !== 'owner' && sheetsRole !== 'pd' && sheetsRole !== 'producer') {
            return addCors(json({ error: 'Admin/PD only' }, 403));
          }
        }
        const res = await handleSheetsAPI(path, request, env);
        return addCors(res);
      }

      // Slack Events API webhook (no JWT ??verified by Slack signing secret)
      if (path === '/api/slack/webhook' && request.method === 'POST') {
        const res = await handleSlackWebhook(request, env, ctx);
        return addCors(res);
      }
      // Slack notification bridge
      if (path.startsWith('/api/slack')) {
        const res = await handleSlackAPI(path, request, env);
        return addCors(res);
      }

      // ?뚮┝/由ы룷??API (progress_reports + cowork_events)
      if (path.startsWith('/api/reports')) {
        const res = await handleReportsAPI(path, request, env);
        return addCors(res);
      }

      // ?대?吏 ?앹꽦 API
      // [v5.14.25] /api/imagegen ?쒓굅 ??/api/gpt-image濡??듯빀
      if (path.startsWith('/api/imagegen')) {
        return addCors(json({ error: 'Deprecated. Use /api/gpt-image instead.', redirect: '/api/gpt-image' + path.replace('/api/imagegen', '') }, 410));
      }

      // Opus 4.7 遺꾩꽍 ?뚯씠?꾨씪??API
      if (path.startsWith('/api/analysis/')) {
        const res = await handleAnalysisPipelineAPI(path, request, env);
        return addCors(res);
      }

      // AI result logs for Obsidian handoff
      if (path.startsWith('/api/ai-log/')) {
        const res = await handleAILogAPI(path, request, env);
        return addCors(res);
      }

      // Video Edit AI API
      if (path.startsWith('/api/video-edit/')) {
        const res = await handleVideoEditAPI(path, request, env);
        return addCors(res);
      }

      // ?쇰뱶諛?猷⑦봽 API
      if (path.startsWith('/api/feedback')) {
        const res = await handleFeedbackAPI(path, request, env);
        return addCors(res);
      }

      // Admin API (鍮꾩슜 紐⑤땲?곕쭅 ??
      if (path.startsWith('/api/admin/')) {
        const adminApiAuth = await requireAdmin(request, env);
        if (!adminApiAuth) return addCors(json({ error: 'Unauthorized' }, 401), request, env);
        const res = await handleAdminAPI(path, request, env);
        return addCors(res);
      }

      // 媛???뱀씤?붿껌 愿由?API
      if (path.startsWith('/api/signup-requests')) {
        const res = await handleSignupRequests(path, request, env);
        return addCors(res);
      }

      // ?뱀씤?붿껌 API
      if (path.startsWith('/api/approvals')) {
        const res = await handleApprovalsAPI(path, request, env);
        return addCors(res);
      }

      // API ?쇱슦??
      if (path.startsWith('/api/')) {
        const res = await handleAPI(path, request, env);
        return addCors(res);
      }

      // R2 紐⑤뱢 ?쒕튃: /modules/*.js
      if (path.startsWith('/modules/') && path.endsWith('.js')) {
        const key = path.slice(1); // 'modules/ai-studio.js'
        const obj = await env.ASSETS.get(key);
        if (!obj) return addCors(json({ error: 'Module not found' }, 404));
        return new Response(obj.body, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
            'Vary': 'Accept-Encoding',
            ...corsHeaders()
          }
        });
      }

      // Next.js production UI preview served from R2.
      // R2 prefix: production-ui/
      if (path === '/lab' || path === '/lab/' || path.startsWith('/lab/')) {
        const rel = path.replace(/^\/lab\/?/, '').replace(/\/+$/, '');
        const candidates = [];
        if (!rel) {
          candidates.push('production-ui/lab.html');
        } else if (/\.[a-z0-9]+$/i.test(rel)) {
          candidates.push('production-ui/lab/' + rel);
        } else {
          candidates.push('production-ui/lab/' + rel + '.html');
          candidates.push('production-ui/lab/' + rel + '/index.html');
        }
        for (const key of candidates) {
          const obj = await env.ASSETS.get(key);
          if (!obj) continue;
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          if (!headers.get('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
          headers.set('Cache-Control', key.endsWith('.html') ? 'no-store, no-cache, must-revalidate, max-age=0' : 'public, max-age=31536000, immutable');
          headers.set('Vary', 'Accept-Encoding');
          return new Response(obj.body, { headers });
        }
        return new Response('Lab UI asset not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      if (path === '/production' || path.startsWith('/production/')) {
        const rel = decodeURIComponent(path.replace(/^\/production\/?/, ''));

        // P0-3: settings ?섏씠吏 admin/pd ?꾩슜 寃뚯씠??
        if (rel === 'settings' || rel.startsWith('settings/')) {
          const jwtToken = getJwtFromCookie(request);
          if (!jwtToken) return redirectNoStore(url.origin + '/login');
          const payload = await verifyJWT(jwtToken, env.JWT_SECRET);
          if (!payload) return redirectNoStore(url.origin + '/login');
          const userRole = String(payload.role || '').toLowerCase();
          if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'pd' && userRole !== 'producer') {
            return new Response('Forbidden: Admin/PD only', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          }
        }

        const candidates = [];
        if (!rel) {
          candidates.push('production-ui/index.html');
        } else if (rel.startsWith('_next/')) {
          candidates.push('production-ui/' + rel);
        } else if (/\.[a-z0-9]+$/i.test(rel)) {
          candidates.push('production-ui/' + rel);
        } else {
          candidates.push('production-ui/' + rel + '.html');
          candidates.push('production-ui/' + rel + '/index.html');
        }

        for (const key of candidates) {
          const obj = await env.ASSETS.get(key);
          if (!obj) continue;
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          if (!headers.get('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
          headers.set('Cache-Control', key.endsWith('.html') ? 'no-store, no-cache, must-revalidate, max-age=0' : 'public, max-age=31536000, immutable');
          headers.set('Vary', 'Accept-Encoding');
          return new Response(obj.body, { headers });
        }
        return new Response('Production UI asset not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      if (path === '/seednanceAPI' || path === '/seednanceapi') {
        const jwtToken = getJwtFromCookie(request);
        if (!jwtToken) return redirectNoStore(url.origin + '/login');
        const payload = await verifyJWT(jwtToken, env.JWT_SECRET);
        if (!payload) return redirectNoStore(url.origin + '/login');

        const obj = await env.ASSETS.get('production-ui/seednanceAPI.html');
        if (obj) {
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          if (!headers.get('Content-Type')) headers.set('Content-Type', 'text/html; charset=utf-8');
          headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
          headers.set('Vary', 'Accept-Encoding');
          return new Response(obj.body, { headers });
        }
        return Response.redirect(url.origin + '/production/higgsfield', 302);
      }

      // [v5.14.27] /app/* sub-paths ??/production/* redirect (Next.js basePath migration)
      if (path.startsWith('/app/') && path !== '/app') {
        return Response.redirect(url.origin + path.replace('/app/', '/production/'), 302);
      }

      // Serve HTML from D1 ??route to page keys
      const PAGE_ROUTES = {
        '/app': '/app', '/design': '/design', '/asset': '/asset',
        '/animation': '/animation', '/render': '/render', '/fx': '/fx',
        '/signup': '/signup', '/login': '/login',
        '/reviews': '/reviews', '/schedule': '/schedule',
        '/seedance': '/seedance',
      };
      // [v5.14.25] ?덇굅???섏씠吏 ??production UI 由щ떎?대젆??
      const LEGACY_REDIRECTS = {
        '/legacy': '/production', '/imagegen': '/production',
        '/higgsfield': '/production/higgsfield',
        '/seedance-auto': '/production/higgsfield',
        '/board': '/production/tasks', '/tbo': '/production',
        '/shotgrid': '/production/shots', '/shotgrid-claude': '/production/shots', '/shots': '/production/shots'
      };
      const cleanPath = path.replace(/\/+$/, '') || '/';
      if (LEGACY_REDIRECTS[cleanPath]) {
        return Response.redirect(url.origin + LEGACY_REDIRECTS[cleanPath], 302);
      }
      const pageKey = PAGE_ROUTES[cleanPath] || '/';

      // JWT 荑좏궎 ?몄쬆: 硫붿씤 ??/) ?묎렐 ??濡쒓렇???꾩닔
      if (pageKey === '/' || pageKey === '/seedance' || pageKey === '/seedance-auto') {
        const jwtCookie = getJwtFromCookie(request);
        if (!jwtCookie) {
          return redirectNoStore(url.origin + '/login');
        }
        const jwtUser = await verifyJWT(jwtCookie, env.JWT_SECRET);
        if (!jwtUser) {
          return redirectNoStore(url.origin + '/login');
        }
        if (pageKey === '/') return redirectNoStore(url.origin + '/production');
      }

      const page = await env.DB.prepare(
        "SELECT content FROM static_pages WHERE key = ?"
      ).bind(pageKey).first();
      if (page && page.content) {
        // 踰꾩쟾 ?먮룞 二쇱엯: HTML ??VER 蹂?섏? ?쒖떆 ?띿뒪?몃? Worker 踰꾩쟾?쇰줈 援먯껜
        let html = page.content;
        if (pageKey === '/') {
          html = html.replace(/var VER = 'v[\d.]+'/g, "var VER = '" + WORKER_VERSION + "'");
          html = html.replace(/Production v[\d.]+/g, 'Production ' + WORKER_VERSION);
        }
        const cacheControl = pageKey === '/login' || pageKey === '/'
          ? 'no-store, no-cache, must-revalidate, max-age=0'
          : 'public, max-age=300, s-maxage=600';
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl, 'Vary': 'Accept-Encoding' }
        });
      }
      return new Response('STUDIOJUN v5.0 - Setup required', { headers: { 'Content-Type': 'text/plain' } });
    } catch (err) {
      return addCors(json({ error: err.message, stack: err.stack }, 500));
    }
  }
};

// ===== AI Router =====
async function handleAI(path, req, env) {
  // ?몄쬆 (JWT ?먮뒗 API ?좏겙)
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  if (path === '/ai/translate' && req.method === 'POST') return aiTranslate(req, env, user);
  if (path === '/ai/chat' && req.method === 'POST') return aiChat(req, env, user);
  if (path === '/ai/producer' && req.method === 'POST') return aiProducerChat(req, env, user);
  if (path === '/ai/briefing' && req.method === 'POST') return aiProducerBriefing(req, env, user);
  if (path === '/ai/query' && req.method === 'POST') return aiQuery(req, env, user);
  if (path === '/ai/analyze' && req.method === 'POST') return aiAnalyze(req, env, user);
  if (path === '/ai/report/daily' && req.method === 'POST') return aiReport(req, env, user, 'daily');
  if (path === '/ai/report/weekly' && req.method === 'POST') return aiReport(req, env, user, 'weekly');
  if (path === '/ai/suggest' && req.method === 'POST') return aiSuggest(req, env, user);
  if (path === '/ai/summarize' && req.method === 'POST') return aiSummarize(req, env, user);

  // Guide Video Analysis endpoints
  if (path === '/ai/guide/session' && req.method === 'POST') return guideCreateSession(req, env, user);
  if (path === '/ai/guide/transcript' && req.method === 'POST') return guideTranscript(req, env);
  if (path === '/ai/guide/translate' && req.method === 'POST') return guideTranslate(req, env);
  if (path === '/ai/guide/scene-cut' && req.method === 'POST') return guideSceneCut(req, env);
  if (path.startsWith('/ai/guide/session/') && req.method === 'GET') {
    const sessionId = path.split('/ai/guide/session/')[1];
    return guideGetSession(sessionId, env);
  }
  if (path.startsWith('/ai/guide/vtt/') && req.method === 'GET') {
    const parts = path.split('/ai/guide/vtt/')[1];
    const sessionId = parts.split('?')[0];
    const lang = new URL(req.url).searchParams.get('lang') || 'ko';
    return guideVTT(sessionId, lang, env);
  }

  return json({ error: 'AI endpoint not found' }, 404);
}

// ===== R2 Router =====
async function handleR2(path, req, env) {
  const bucket = env.ASSETS || env.R2;
  if (!bucket) return json({ error: 'R2 bucket binding is not configured' }, 500);

  if (path === '/r2/upload' && req.method === 'POST') {
    const user = await authenticateAny(req, env);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const formData = await req.formData();
    const file = formData.get('file');
    if (!file) return json({ error: 'No file' }, 400);

    const projectId = formData.get('project_id') || 'default';
    const folder = formData.get('folder') || 'attachments';
    const shotId = formData.get('shot_id') || null;
    const fileName = file.name || formData.get('filename') || 'upload_' + Date.now();
    const fileSize = file.size || parseInt(formData.get('filesize')) || 0;
    const mimeType = file.type || formData.get('mimetype') || '';

    const key = `${projectId}/${folder}/${Date.now()}_${fileName}`;
    await bucket.put(key, file, {
      httpMetadata: { contentType: mimeType }
    });

    await env.DB.prepare(
      'INSERT INTO files (project_id, shot_id, filename, r2_key, size, mime_type) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(projectId, shotId, fileName, key, fileSize, mimeType).run();

    return json({ key, url: `/r2/download/${key}`, filename: fileName, size: fileSize }, 201);
  }

  // Download with Range support for video streaming
  if (path.startsWith('/r2/download/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const key = decodeURIComponent(path.replace('/r2/download/', ''));
    return serveR2Object(bucket, key, req);
  }

  // Public R2 media/file serving. Supports both /r2/public/:key and /r2/:key.
  // This keeps generated media URLs fast for video review players.
  if ((req.method === 'GET' || req.method === 'HEAD') && (path.startsWith('/r2/public/') || path.startsWith('/r2/'))) {
    const prefix = path.startsWith('/r2/public/') ? '/r2/public/' : '/r2/';
    const key = decodeURIComponent(path.replace(prefix, ''));
    if (!key || ['upload', 'download', 'delete', 'list'].includes(key.split('/')[0])) {
      return json({ error: 'R2 endpoint not found' }, 404);
    }
    return serveR2Object(bucket, key, req);
  }

  // Delete
  if (path.startsWith('/r2/delete/') && req.method === 'DELETE') {
    const user = await authenticateAny(req, env);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const key = path.replace('/r2/delete/', '');
    await bucket.delete(key);
    await env.DB.prepare('DELETE FROM files WHERE r2_key = ?').bind(key).run();
    return json({ deleted: key });
  }

  // List files for a shot
  if (path === '/r2/list' && req.method === 'GET') {
    const url = new URL(req.url);
    const shotId = url.searchParams.get('shot_id');
    const projectId = url.searchParams.get('project') || 'default';
    let sql = 'SELECT * FROM files WHERE project_id = ?';
    const params = [projectId];
    if (shotId) { sql += ' AND shot_id = ?'; params.push(shotId); }
    sql += ' ORDER BY id DESC';
    const { results } = await env.DB.prepare(sql).bind(...params).all();
    return json(results.map(f => ({ ...f, url: `/r2/download/${f.r2_key}` })));
  }

  return json({ error: 'R2 endpoint not found' }, 404);
}

async function serveR2Object(bucket, key, req) {
  if (req.method === 'HEAD') {
    const object = await bucket.head(key);
    if (!object) return json({ error: 'File not found', key }, 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Vary', 'Range');
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = req.headers.get('Range');
  const object = rangeHeader
    ? await bucket.get(key, { range: req.headers })
    : await bucket.get(key);
  if (!object) return json({ error: 'File not found', key }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Vary', 'Range');

  if (rangeHeader && object.range) {
    headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
    headers.set('Content-Length', String(object.range.length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// ===== AI Functions =====

async function getProjectContext(env, projectId) {
  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status='confirm' THEN 1 ELSE 0 END) as review,
      SUM(CASE WHEN status='hold' THEN 1 ELSE 0 END) as hold,
      SUM(CASE WHEN status='production' THEN 1 ELSE 0 END) as production,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending
    FROM shots WHERE project_id = ?
  `).bind(projectId).first();

  const { results: teamStats } = await env.DB.prepare(`
    SELECT team, status, COUNT(*) as cnt
    FROM shots WHERE project_id = ?
    GROUP BY team, status ORDER BY team
  `).bind(projectId).all();

  const { results: recentActivity } = await env.DB.prepare(`
    SELECT * FROM activity_log WHERE project_id = ?
    ORDER BY created_at DESC LIMIT 15
  `).bind(projectId).all();

  const { results: assigneeLoad } = await env.DB.prepare(`
    SELECT assignee, team, COUNT(*) as total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status='production' THEN 1 ELSE 0 END) as in_progress
    FROM shots WHERE project_id = ? AND assignee != '' AND assignee IS NOT NULL
    GROUP BY assignee ORDER BY total DESC
  `).bind(projectId).all();

  const { results: epStats } = await env.DB.prepare(`
    SELECT
      SUBSTR(scene, 1, 4) as ep,
      COUNT(*) as total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done
    FROM shots WHERE project_id = ?
    GROUP BY SUBSTR(scene, 1, 4) ORDER BY ep
  `).bind(projectId).all();

  return { stats, teamStats, recentActivity, assigneeLoad, epStats };
}

function buildSystemPrompt(ctx, extra) {
  const { stats, teamStats, assigneeLoad, epStats } = ctx;
  const progress = stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0;

  const teamSummary = {};
  for (const t of teamStats) {
    if (!teamSummary[t.team]) teamSummary[t.team] = {};
    teamSummary[t.team][t.status] = t.cnt;
  }

  return `?뱀떊? STUDIOJUN 3D ?좊땲硫붿씠???꾨줈?뺤뀡 愿由?AI ?댁떆?ㅽ꽩?몄엯?덈떎.
??긽 ?쒓뎅?대줈 ?듬??섏꽭?? ?곗씠?곗뿉 湲곕컲???뺥솗???듬?留??섏꽭??

## ?꾩옱 ?꾨줈?앺듃 ?꾪솴
- ?꾩껜 ?? ${stats.total}媛?- ?꾨즺(done): ${stats.done}媛?(${progress}%)
- 由щ럭(confirm): ${stats.review}媛?- 吏꾪뻾以?production): ${stats.production}媛?- ?湲?pending): ${stats.pending}媛?- ???hold): ${stats.hold}媛?
## ?蹂??꾪솴
${Object.entries(teamSummary).map(([team, s]) =>
  `- ${team}: ?꾩껜 ${Object.values(s).reduce((a,b)=>a+b,0)}媛?/ ?꾨즺 ${s.done||0} / 吏꾪뻾 ${s.production||0} / 由щ럭 ${s.confirm||0} / ???${s.hold||0}`
).join('\n')}

## ?먰뵾?뚮뱶蹂?吏꾪뻾瑜?${epStats.map(e => `- ${e.ep}: ${e.done}/${e.total} (${Math.round(e.done/e.total*100)}%)`).join('\n')}

## ?대떦?먮퀎 ?뚰겕濡쒕뱶 (?곸쐞)
${assigneeLoad.slice(0, 15).map(a =>
  `- ${a.assignee} (${a.team}): ?꾩껜 ${a.total} / ?꾨즺 ${a.done} / 吏꾪뻾 ${a.in_progress}`
).join('\n')}

${extra || ''}`;
}

async function callClaude(env, model, systemPrompt, userMessage, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function logAIUsage(env, userId, endpoint, model, inputTokens, outputTokens) {
  await env.DB.prepare(
    'INSERT INTO api_usage (user_id, endpoint, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
  ).bind(userId, endpoint, model, inputTokens, outputTokens).run();
}

// POST /ai/translate
async function aiTranslate(req, env, user) {
  const body = await req.json();
  const text = body.text;
  const target = body.target || body.to_lang || body.lang;
  const source = body.source || body.from_lang || 'auto';
  const context = body.context || body.domain || 'animation_feedback';
  if (!text || !target) return json({ error: 'text and target required' }, 400);

  const langNames = { ko: 'Korean', en: 'English', vi: 'Vietnamese' };
  const model = 'claude-haiku-4-5-20251001';
  const result = await callClaude(env, model,
    `You are a multilingual translation assistant for a 3D animation production studio.
Preserve animation and VFX production terminology accurately. Understand feedback about Maya, rigging, layout, blocking, spline, polish, timing, spacing, arcs, silhouette, camera, lighting, render, compositing, FX, cache, playblast, frame ranges, shot codes, asset names, and version names.
Do not translate shot IDs, file names, character names, asset codes, software names, frame numbers, or version numbers.
Keep feedback actionable and natural for artists. Return ONLY the translated text.`,
    `<context>${context}</context>
<source_language>${source}</source_language>
<target_language>${langNames[target] || target}</target_language>
<text>${text}</text>`,
    400
  );

  await logAIUsage(env, user.id, '/ai/translate', model, result.usage?.input_tokens, result.usage?.output_tokens);
  return json({ translated: result.content[0].text, translation: result.content[0].text, model });
}

// POST /ai/chat
async function aiChat(req, env, user) {
  const { message, project_id } = await req.json();
  if (!message) return json({ error: 'message required' }, 400);

  const projectId = project_id || 'default';
  const ctx = await getProjectContext(env, projectId);
  const systemPrompt = buildSystemPrompt(ctx, `
吏덈Ц??媛꾧껐?섍퀬 紐낇솗?섍쾶 ?듬??섏꽭??
?섏튂 ?곗씠?곕? ?ы븿???뚮뒗 ???뺤떇???ъ슜?섏꽭??
異붿륫?섏? 留먭퀬, ?곗씠?곗뿉 ?녿뒗 ?댁슜? "?곗씠?곌? ?놁뒿?덈떎"?쇨퀬 ?듯븯?몄슂.`);

  const model = 'claude-haiku-4-5-20251001';
  const result = await callClaude(env, model, systemPrompt, message, 1024);

  // ???湲곕줉 ???
  await env.DB.prepare(
    'INSERT INTO ai_conversations (project_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?)'
  ).bind(projectId, user.id, 'user', message, null).run();
  await env.DB.prepare(
    'INSERT INTO ai_conversations (project_id, user_id, role, content, model, tokens_used) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(projectId, user.id, 'assistant', result.content[0].text, model, result.usage?.output_tokens).run();

  await logAIUsage(env, user.id, '/ai/chat', model, result.usage?.input_tokens, result.usage?.output_tokens);
  return json({ reply: result.content[0].text, model });
}

// ===== 珥앷큵 ?꾨줈???AI 梨꾪똿 =====
// POST /ai/producer ???꾨줈????꾩슜 Claude ?뚰넻 梨꾨꼸
async function aiProducerChat(req, env, user) {
  const { message, project_id, history } = await req.json();
  if (!message) return json({ error: 'message required' }, 400);

  const projectId = project_id || 'default';
  const ctx = await getProjectContext(env, projectId);
  const { stats, teamStats, assigneeLoad, epStats } = ctx;
  const progress = stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0;

  const teamSummary = {};
  for (const t of teamStats) {
    if (!teamSummary[t.team]) teamSummary[t.team] = {};
    teamSummary[t.team][t.status] = t.cnt;
  }

  // ?꾪뿕 ?붿냼 媛먯?
  const risks = [];
  for (const [team, s] of Object.entries(teamSummary)) {
    const total = Object.values(s).reduce((a,b)=>a+b,0);
    const hold = s.hold || 0;
    if (hold > 2) risks.push(`?뵶 ${team}?: ???${hold}嫄???利됱떆 ?뺤씤 ?꾩슂`);
  }
  const overloadedMembers = assigneeLoad.filter(a => a.in_progress >= 4);
  for (const m of overloadedMembers) {
    risks.push(`${m.assignee} (${m.team}): in progress ${m.in_progress} - overloaded`);
  }

  const systemPrompt = `?뱀떊? JUN 珥앷큵 ?꾨줈??쒖쓽 ?꾩슜 AI 鍮꾩꽌?낅땲??
3D ?좊땲硫붿씠???꾨줈?뺤뀡 STUDIOJUN????? ?곹솴???ㅼ떆媛꾩쑝濡??뚯븙?섍퀬 蹂닿퀬?⑸땲??

## ?꾩옱 ?꾨줈?앺듃 ?ㅼ떆媛??곗씠??- ?꾩껜 ?? ${stats.total}媛?| ?꾨즺: ${stats.done}媛?(${progress}%) | 吏꾪뻾: ${stats.production}媛?| 由щ럭: ${stats.review}媛?| ?湲? ${stats.pending}媛?| ??? ${stats.hold}媛?
## ?蹂??꾪솴
${Object.entries(teamSummary).map(([team, s]) => {
  const total = Object.values(s).reduce((a,b)=>a+b,0);
  return `- ${team}?: ?꾩껜 ${total} | ?꾨즺 ${s.done||0} | 吏꾪뻾 ${s.production||0} | 由щ럭 ${s.confirm||0} | ???${s.hold||0}`;
}).join('\n')}

## ?먰뵾?뚮뱶 吏꾪뻾瑜?${epStats.map(e => `- ${e.ep}: ${e.done}/${e.total} (${Math.round(e.done/e.total*100)}%)`).join('\n')}

## ?대떦???뚰겕濡쒕뱶 (?곸쐞)
${assigneeLoad.slice(0, 10).map(a => `- ${a.assignee} (${a.team}): in progress ${a.in_progress} / done ${a.done}`).join('\n')}

## ?꾩옱 ?꾪뿕 ?붿냼
${risks.length > 0 ? risks.join('\n') : '?좑툘 媛먯????꾪뿕 ?놁쓬'}

## ?뚰넻 ?먯튃
- ??긽 ?쒓뎅?대줈 ?듬?
- ?곗씠??湲곕컲?쇰줈 ?뺥솗?섍쾶 蹂닿퀬
- ?꾪뿕 ?붿냼??癒쇱? ?뚮┝
- ?꾨줈???寃곗젙???꾩슂???ы빆? 紐낇솗???쒖떆
- 媛꾧껐?섍퀬 ?ㅼ슜?곸쑝濡?(珥앷큵 ?꾨줈????쒓컙? 洹?섎떎)
- ????꾨떖??硫붿떆吏??紐낇솗???≪뀡 ?꾩씠???ы븿`;

  // ????덉뒪?좊━ ?ы븿 (硫?고꽩)
  const messages = [];
  if (history && Array.isArray(history)) {
    for (const h of history.slice(-10)) { // 理쒓렐 10媛쒕쭔
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: message });

  const model = 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: 2048, system: systemPrompt, messages })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const reply = data.content[0].text;

  // ???湲곕줉 ???
  await env.DB.prepare(
    'INSERT INTO ai_conversations (project_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?)'
  ).bind(projectId, user.id, 'user', message, null).run();
  await env.DB.prepare(
    'INSERT INTO ai_conversations (project_id, user_id, role, content, model, tokens_used) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(projectId, user.id, 'assistant', reply, model, data.usage?.output_tokens).run();

  return json({ reply, model, risks, progress, stats });
}

// POST /ai/briefing - 오전/오후/주간 자동 브리핑
async function aiProducerBriefing(req, env, user) {
  const { type, project_id } = await req.json(); // type: 'morning' | 'afternoon' | 'weekly'
  const projectId = project_id || 'default';
  return generateBriefing(env, projectId, type || 'morning', user?.id);
}

// 브리핑 생성 공통 함수 (Cron + API 모두 사용)
async function generateBriefing(env, projectId, type, userId) {
  const ctx = await getProjectContext(env, projectId);
  const { stats, teamStats, assigneeLoad, epStats } = ctx;
  const progress = stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0;
  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = kstTime.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const teamSummary = {};
  for (const t of teamStats) {
    if (!teamSummary[t.team]) teamSummary[t.team] = {};
    teamSummary[t.team][t.status] = t.cnt;
  }

  const risks = [];
  for (const [team, s] of Object.entries(teamSummary)) {
    if ((s.hold || 0) > 2) risks.push(`⚠️ ${team}팀 홀드 ${s.hold}개`);
    if ((s.production || 0) === 0 && (s.pending || 0) > 5) risks.push(`🔴 ${team}팀 진행 중 없음, 배정 필요`);
  }
  const overloaded = assigneeLoad.filter(a => a.in_progress >= 4);
  for (const m of overloaded) risks.push(`🔴 ${m.assignee}(${m.team}) 과부하 ${m.in_progress}개`);

  const briefingType = { morning: '오전 브리핑', afternoon: '오후 리뷰', weekly: '주간 리포트' }[type] || '브리핑';
  const prompt = `다음 3D 애니메이션 프로덕션 데이터를 바탕으로 총괄 프로듀서(JUN)를 위한 ${briefingType}을 작성하세요.

## 일시: ${dateStr}
## 프로젝트 현황
- 전체: ${stats.total}샷 | 완료: ${stats.done}(${progress}%) | 진행: ${stats.production} | 리뷰: ${stats.review} | 홀드: ${stats.hold}

## 팀별 ${Object.entries(teamSummary).map(([t, s]) =>
  `${t}: 완료${s.done||0}/진행${s.production||0}/리뷰${s.confirm||0}/홀드${s.hold||0}`
).join(', ')}

## 에피소드
${epStats.map(e => `${e.ep}: ${e.done}/${e.total}(${Math.round(e.done/e.total*100)}%)`).join(' | ')}

## 감지된 위험
${risks.length > 0 ? risks.join('\n') : '없음'}

${type === 'morning' ? '오전 브리핑: 오늘 목표, 위험 요소, 프로듀서 결정 필요 사항 포함' : ''}
${type === 'afternoon' ? '오후 리뷰: 오늘 진행 현황, 내일 준비사항, 미완료 이슈 포함' : ''}
${type === 'weekly' ? '주간 리포트: 이번 주 성과, 다음 주 계획, 팀별 KPI, 대응 필요 리스크 포함' : ''}

간결하고 실용적으로 작성. 프로듀서가 즉시 판단할 수 있도록.`;

  const model = 'claude-sonnet-4-6';
  const result = await callClaude(env, model, '당신은 STUDIOJUN 프로덕션 AI 비서입니다. 항상 한국어로 답합니다.', prompt, 2048);
  const briefingText = result.content[0].text;

  // DB에 브리핑 저장
  if (userId) {
    await env.DB.prepare(
      'INSERT INTO ai_conversations (project_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?)'
    ).bind(projectId, userId || 'system', 'assistant', briefingText, model).run();
  }

  return json({ briefing: briefingText, type, date: dateStr, progress, risks, stats });
}
// Cron에서 실행하는 자동 브리핑 (슬랙 발신)
async function sendScheduledBriefing(env, type) {
  const projectId = 'default';
  console.log(`[CRON] Generating ${type} briefing...`);

  // D1에서 데이터 조회
  let report = '';
  try {
    const stats = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM episodes WHERE archived=0) as ep_count,
        (SELECT COUNT(*) FROM shots WHERE archived=0) as shot_total,
        (SELECT COUNT(*) FROM shots WHERE archived=0 AND status='done') as shot_done,
        (SELECT COUNT(*) FROM shots WHERE archived=0 AND status='in_progress') as shot_wip,
        (SELECT COUNT(*) FROM shots WHERE archived=0 AND status='pending') as shot_pending,
        (SELECT COUNT(*) FROM assets WHERE archived=0) as asset_total,
        (SELECT COUNT(*) FROM members WHERE archived=0 AND is_active=1) as member_count
    `).first();

    const pct = stats.shot_total > 0 ? Math.round(stats.shot_done / stats.shot_total * 100) : 0;

    // 최근 24시간 활동
    const oneDayAgo = Date.now() - 86400000;
    const recentShots = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM shots WHERE archived=0 AND updated_at > ?`
    ).bind(oneDayAgo).first();

    const recentTodos = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM todos WHERE updated_at > ?`
    ).bind(oneDayAgo).first();

    if (type === 'morning') {
      report = `☀️ *모닝 브리핑* | ${new Date().toISOString().slice(0,10)}\n\n` +
        `📊 *프로젝트 현황*\n` +
        `• 에피소드: ${stats.ep_count}개 | 샷 ${stats.shot_total}개(완료 ${pct}%)\n` +
        `• 진행중 ${stats.shot_wip} | 대기 ${stats.shot_pending} | 자산 ${stats.asset_total}개\n` +
        `• 활성 멤버: ${stats.member_count}명\n\n` +
        `🔥 *최근 24시간*\n` +
        `• 샷 업데이트: ${recentShots?.cnt || 0}건 | 투두 업데이트: ${recentTodos?.cnt || 0}건`;
    } else if (type === 'afternoon') {
      report = `🌅 *오후 현황* | 전체 진행률 ${pct}% (${stats.shot_done}/${stats.shot_total})\n` +
        `진행중 ${stats.shot_wip} | 대기 ${stats.shot_pending} | 오늘 업데이트 ${recentShots?.cnt || 0}건`;
    } else {
      // weekly
      report = `📅 *주간 리포트* | ${new Date().toISOString().slice(0,10)}\n\n` +
        `• 전체 샷 ${stats.shot_total}개(완료 ${pct}%)\n` +
        `• 자산: ${stats.asset_total}개 | 멤버: ${stats.member_count}명\n` +
        `• 금주 샷 업데이트: ${recentShots?.cnt || 0}건 | 투두: ${recentTodos?.cnt || 0}건`;
    }
  } catch (e) {
    report = `⚠️ [${type}] 브리핑 데이터 조회 실패: ${e.message}`;
    console.error('[CRON] Stats err:', e.message);
  }

  // Slack 커맨드센터에 GREEN 봇으로 포스트
  try {
    const token = await getSlackConfigValue(env, 'SLACK_BOT_TOKEN_GREEN');
    if (token) {
      await postSlackBotMessage(token, { channel: JUN_COMMAND_CENTER_ID, text: report, unfurl_links: false });
    }
  } catch (e) { console.error('[CRON] Slack post err:', e.message); }

  // DB 로깅
  try {
    await env.DB.prepare(
      'INSERT INTO ai_conversations (project_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?)'
    ).bind(projectId, 'cron', 'system', report.slice(0, 500), 'cron').run();
  } catch (e) { console.error('[CRON] Log err:', e.message); }

  console.log(`[CRON] ${type} briefing sent to Slack.`);
}
// POST /ai/query ???먯뿰???곗씠??荑쇰━
async function aiQuery(req, env, user) {
  const { question, project_id } = await req.json();
  if (!question) return json({ error: 'question required' }, 400);

  const projectId = project_id || 'default';
  const ctx = await getProjectContext(env, projectId);

  const model = 'claude-sonnet-4-6-20250514';
  const sqlPrompt = `?뱀떊? SQL ?꾨Ц媛?낅땲?? ?ъ슜?먯쓽 吏덈Ц??SQLite 荑쇰━濡?蹂?섑븯?몄슂.

## ?곗씠?곕쿋?댁뒪 ?ㅽ궎留?- shots: id, project_id, scene, team, status, priority, assignee, start_date, due, note, created_at, updated_at
  - status: 'pending', 'production', 'confirm', 'done', 'hold'
  - team: 'scenario', 'design', 'modeling', 'rigging', 'animation', 'render', 'fx'
  - priority: 'high', 'mid', 'low'
- comments: id, shot_id, author_id, author_name, text, role, created_at
- todos: id, project_id, title, team, priority, assignee, due, shot_id, note, status, created_at
- messages: id, project_id, room, sender_id, sender_name, text, lang, created_at
- activity_log: id, project_id, actor_name, action, target_type, target_id, detail, created_at
- members: id, name, email, role, team, initials

project_id????긽 '${projectId}'濡??꾪꽣留곹븯?몄슂.
SELECT 荑쇰━留??덉슜?⑸땲?? INSERT/UPDATE/DELETE??湲덉??⑸땲??
JSON ?뺤떇?쇰줈 ?묐떟?섏꽭?? {"sql": "SELECT ...", "description": "荑쇰━ ?ㅻ챸"}`;

  const sqlResult = await callClaude(env, model, sqlPrompt, question, 500);
  let sqlText = sqlResult.content[0].text;

  // JSON ?뚯떛
  let sqlObj;
  try {
    const jsonMatch = sqlText.match(/\{[\s\S]*\}/);
    sqlObj = JSON.parse(jsonMatch[0]);
  } catch {
    return json({ reply: '吏덈Ц???댄빐?섏? 紐삵뻽?듬땲?? ?ㅼ떆 吏덈Ц?댁＜?몄슂.', raw: sqlText });
  }

  // SQL ?덉쟾??寃??
  const sqlLower = sqlObj.sql.toLowerCase();
  if (sqlLower.includes('drop') || sqlLower.includes('delete') || sqlLower.includes('update') || sqlLower.includes('insert') || sqlLower.includes('alter')) {
    return json({ error: '?쎄린 ?꾩슜 荑쇰━留??덉슜?⑸땲?' }, 400);
  }

  // 荑쇰━ ?ㅽ뻾
  try {
    const { results } = await env.DB.prepare(sqlObj.sql).all();

    // 寃곌낵瑜??먯뿰?대줈 蹂??
    const summaryPrompt = buildSystemPrompt(ctx, '?ъ슜?먯쓽 吏덈Ц?????SQL 荑쇰━ 寃곌낵瑜??쒓뎅?대줈 ?붿빟?섏꽭?? ???뺤떇???쒖슜?섏꽭??');
    const summaryResult = await callClaude(env, 'claude-haiku-4-5-20251001', summaryPrompt,
      `吏덈Ц: ${question}\nSQL: ${sqlObj.sql}\n寃곌낵 (${results.length}??:\n${JSON.stringify(results.slice(0, 50), null, 2)}`,
      1024
    );

    await logAIUsage(env, user.id, '/ai/query', model,
      (sqlResult.usage?.input_tokens || 0) + (summaryResult.usage?.input_tokens || 0),
      (sqlResult.usage?.output_tokens || 0) + (summaryResult.usage?.output_tokens || 0)
    );

    return json({
      reply: summaryResult.content[0].text,
      sql: sqlObj.sql,
      description: sqlObj.description,
      resultCount: results.length,
      data: results.slice(0, 100)
    });
  } catch (sqlErr) {
    return json({ reply: `荑쇰━ ?ㅽ뻾 ?ㅻ쪟: ${sqlErr.message}`, sql: sqlObj.sql }, 500);
  }
}

// POST /ai/analyze ??蹂묐ぉ 遺꾩꽍
async function aiAnalyze(req, env, user) {
  const { project_id, depth } = await req.json();
  const projectId = project_id || 'default';
  const ctx = await getProjectContext(env, projectId);

  // 異붽? ?곗씠?? 留덇컧 ?꾨컯 ?? ?ㅻ옒 吏꾪뻾 以묒씤 ??
  const { results: overdue } = await env.DB.prepare(`
    SELECT id, scene, team, assignee, due, status FROM shots
    WHERE project_id = ? AND due != '' AND due < date('now') AND status NOT IN ('done')
    ORDER BY due ASC LIMIT 20
  `).bind(projectId).all();

  const { results: stale } = await env.DB.prepare(`
    SELECT id, scene, team, assignee, status, updated_at FROM shots
    WHERE project_id = ? AND status = 'production' AND updated_at < ?
    ORDER BY updated_at ASC LIMIT 20
  `).bind(projectId, Date.now() - 7 * 24 * 60 * 60 * 1000).all();

  const { results: holdShots } = await env.DB.prepare(`
    SELECT id, scene, team, assignee, note FROM shots
    WHERE project_id = ? AND status = 'hold'
    ORDER BY updated_at DESC
  `).bind(projectId).all();

  const extraContext = `
## 留덇컧 珥덇낵 ??(${overdue.length}媛?
${overdue.map(s => `- ${s.id} (${s.team}/${s.assignee}) 留덇컧: ${s.due}`).join('\n') || '?놁쓬'}

## 7???댁긽 吏꾪뻾 蹂???녿뒗 ??(${stale.length}媛?
${stale.map(s => `- ${s.id} (${s.team}/${s.assignee}) 留덉?留??낅뜲?댄듃: ${new Date(s.updated_at).toLocaleDateString()}`).join('\n') || '?놁쓬'}

## ?????(${holdShots.length}媛?
${holdShots.map(s => `- ${s.id} (${s.team}/${s.assignee}) ?ъ쑀: ${s.note || '誘멸린'}`).join('\n') || '?놁쓬'}`;

  const model = 'claude-sonnet-4-6-20250514';
  const systemPrompt = buildSystemPrompt(ctx, extraContext + `

## 遺꾩꽍 ?붿껌
?ㅼ쓬 ??ぉ??遺꾩꽍?섏꽭??
1. **蹂묐ぉ ?/?대떦??*: ?대뼡 ??대굹 ?대떦?먭? 媛??吏?곕릺怨??덈뒗吏
2. **?꾪뿕 ?먰뵾?뚮뱶**: 吏꾪뻾瑜좎씠 ??? ?먰뵾?뚮뱶
3. **留덇컧 ?꾪뿕**: 留덇컧 珥덇낵 諛??꾨컯 ??4. **由ъ냼??遺덇퇏??*: ?뚰겕濡쒕뱶媛 怨쇰룄???대떦??5. **媛쒖꽑 ?쒖븞**: 援ъ껜?곸씤 ?≪뀡 ?꾩씠??3-5媛?
留덊겕?ㅼ슫 ?뺤떇?쇰줈 援ъ“?붾맂 蹂닿퀬?쒕? ?묒꽦?섏꽭??`);

  const result = await callClaude(env, model, systemPrompt,
    depth === 'detailed' ? '?꾩껜 ?꾨줈?앺듃??????곸꽭 蹂묐ぉ 遺꾩꽍???댁＜?몄슂.' : '?꾨줈?앺듃 蹂묐ぉ 遺꾩꽍 ?붿빟???댁＜?몄슂.',
    2048
  );

  await logAIUsage(env, user.id, '/ai/analyze', model, result.usage?.input_tokens, result.usage?.output_tokens);
  return json({ reply: result.content[0].text, model, overdue: overdue.length, stale: stale.length, hold: holdShots.length });
}

// POST /ai/report/daily, /ai/report/weekly
async function aiReport(req, env, user, type) {
  const { project_id } = await req.json();
  const projectId = project_id || 'default';

  // 罹먯떆 ?뺤씤 (媛숈? ??媛숈? 二쇱쓽 蹂닿퀬?쒓? ?덉쑝硫??ъ궗??
  const cacheId = `${type}_${projectId}_${new Date().toISOString().slice(0, type === 'daily' ? 10 : 7)}`;
  const cached = await env.DB.prepare('SELECT content FROM report_cache WHERE id = ?').bind(cacheId).first();
  if (cached) return json({ reply: cached.content, cached: true });

  const ctx = await getProjectContext(env, projectId);

  const period = type === 'daily' ? 'daily' : 'weekly';
  const timeFilter = type === 'daily'
    ? Date.now() - 24 * 60 * 60 * 1000
    : Date.now() - 7 * 24 * 60 * 60 * 1000;

  const { results: recentChanges } = await env.DB.prepare(`
    SELECT * FROM activity_log WHERE project_id = ? AND created_at > ?
    ORDER BY created_at DESC LIMIT 50
  `).bind(projectId, timeFilter).all();

  const { results: completedShots } = await env.DB.prepare(`
    SELECT id, scene, team, assignee FROM shots
    WHERE project_id = ? AND status = 'done' AND updated_at > ?
  `).bind(projectId, timeFilter).all();

  const extraContext = `
## ${period} ?쒕룞 (${recentChanges.length}嫄?
${recentChanges.slice(0, 20).map(a => `- ${a.detail} (${a.actor_name || '?쒖뒪'}`).join('\n') || '?쒕룞 ?놁쓬'}

## ${period} ?꾨즺 ??(${completedShots.length}媛?
${completedShots.map(s => `- ${s.id} (${s.team}/${s.assignee})`).join('\n') || '?놁쓬'}`;

  const model = 'claude-sonnet-4-6-20250514';
  const systemPrompt = buildSystemPrompt(ctx, extraContext + `

## ${type === 'daily' ? '?쇱씪' : '二쇨컙'} 蹂닿퀬???묒꽦
?ㅼ쓬 援ъ“濡?蹂닿퀬?쒕? ?묒꽦?섏꽭??
1. **?붿빟**: ??以??붿빟
2. **${period} ?깃낵**: ?꾨즺??二쇱슂 ?묒뾽
3. **?蹂??꾪솴**: 媛????吏꾪뻾 ?곹깭
4. **二쇱쓽 ?ы빆**: 留덇컧 ?꾨컯, 蹂묐ぉ, ?????5. **?댁씪/?ㅼ쓬二?紐⑺몴**: ?곗꽑?쒖쐞 ?묒뾽

留덊겕?ㅼ슫 ?쒕? ?곴레 ?쒖슜?섏꽭??`);

  const result = await callClaude(env, model, systemPrompt,
    `${type === 'daily' ? '?쇱씪' : '二쇨컙'} ?꾨줈?뺤뀡 蹂닿퀬?쒕? ?앹꽦?댁＜?몄슂.`,
    2048
  );

  // 罹먯떆 ???
  await env.DB.prepare(
    'INSERT OR REPLACE INTO report_cache (id, project_id, report_type, content) VALUES (?, ?, ?, ?)'
  ).bind(cacheId, projectId, type, result.content[0].text).run();

  await logAIUsage(env, user.id, `/ai/report/${type}`, model, result.usage?.input_tokens, result.usage?.output_tokens);
  return json({ reply: result.content[0].text, model, cached: false });
}

// POST /ai/suggest ???먮룞 ?좊떦 ?쒖븞
async function aiSuggest(req, env, user) {
  const { project_id, shot_ids } = await req.json();
  const projectId = project_id || 'default';
  const ctx = await getProjectContext(env, projectId);

  const { results: unassigned } = await env.DB.prepare(`
    SELECT id, scene, team, priority FROM shots
    WHERE project_id = ? AND (assignee IS NULL OR assignee = '') AND status = 'pending'
    ORDER BY priority DESC, created_at ASC LIMIT 20
  `).bind(projectId).all();

  const model = 'claude-haiku-4-5-20251001';
  const systemPrompt = buildSystemPrompt(ctx, `
## 誘명븷????(${unassigned.length}媛?
${unassigned.map(s => `- ${s.id} (${s.team}, ?곗꽑?쒖쐞: ${s.priority})`).join('\n')}

?대떦?먮퀎 ?꾩옱 ?뚰겕濡쒕뱶瑜?怨좊젮?섏뿬 理쒖쟻???좊떦???쒖븞?섏꽭??
JSON 諛곗뿴濡??묐떟: [{"shot_id": "...", "assignee": "...", "reason": "..."}]`);

  const result = await callClaude(env, model, systemPrompt, '誘명븷???룹뿉 ????대떦???좊떦???쒖븞?댁＜?몄슂.', 1024);

  await logAIUsage(env, user.id, '/ai/suggest', model, result.usage?.input_tokens, result.usage?.output_tokens);
  return json({ reply: result.content[0].text, model });
}

// POST /ai/summarize ??肄붾찘???붿빟
async function aiSummarize(req, env, user) {
  const { shot_id } = await req.json();
  if (!shot_id) return json({ error: 'shot_id required' }, 400);

  const { results: comments } = await env.DB.prepare(
    'SELECT author_name, text, created_at FROM comments WHERE shot_id = ? ORDER BY created_at ASC'
  ).bind(shot_id).all();

  if (!comments.length) return json({ reply: '肄붾찘?멸? ?놁뒿?덈떎.' });

  const model = 'claude-haiku-4-5-20251001';
  const result = await callClaude(env, model,
    '?좊땲硫붿씠???꾨줈?뺤뀡 肄붾찘?몃? ?붿빟?섏꽭?? ?듭떖 ?쇰뱶諛? ?섏젙 ?붿껌 ?ы빆, ?닿껐/誘명빐寃??댁뒋瑜?援щ텇?섏꽭?? ?쒓뎅?대줈 ?듬?.',
    `??${shot_id}??肄붾찘??(${comments.length}媛?:\n${comments.map(c =>
      `[${new Date(c.created_at).toLocaleDateString()}] ${c.author_name}: ${c.text}`
    ).join('\n')}`,
    512
  );

  await logAIUsage(env, user.id, '/ai/summarize', model, result.usage?.input_tokens, result.usage?.output_tokens);
  return json({ reply: result.content[0].text, model, commentCount: comments.length });
}

// ===== API Router =====
const PRODUCTION_API_RESOURCES = new Set([
  'shots', 'assets', 'todos', 'comments', 'messages', 'projects', 'members',
  'stats', 'activity', 'reviews', 'files', 'pipeline', 'nas', 'folder'
]);

const INTERNAL_ROLES = new Set(['admin', 'owner', 'pd', 'producer']);
const SUPERVISOR_ROLES = new Set(['supervisor', 'lead']);
const REVIEW_ROLES = new Set(['director', 'reviewer', 'client']);
const ARTIST_ROLES = new Set(['artist', 'vendor', 'member']);
const TBO_PROJECT_ALIASES = new Set(['default', 'tbo', 'turbo one', 'turboone', 'tb', 'production']);
const PRODUCTION_ACTION_TYPES = new Set([
  'feedback_created',
  'feedback_translated',
  'qna_created',
  'qna_answered',
  'todo_created',
  'todo_status_changed',
  'review_status_changed',
  'file_version_registered',
  'sheet_write_queued',
  'seedance_packet_created',
  'seedance_job_status'
]);
const REVIEW_ACTION_TYPES = new Set([
  'feedback_created',
  'feedback_translated',
  'qna_created',
  'qna_answered',
  'review_status_changed'
]);
const ARTIST_ACTION_TYPES = new Set([
  'qna_created',
  'qna_answered',
  'todo_status_changed',
  'file_version_registered',
  'review_status_changed'
]);
const MANAGER_ONLY_ACTION_TYPES = new Set([
  'sheet_write_queued',
  'seedance_job_status'
]);
const PRODUCTION_EXTERNAL_REDACT_KEYS = new Set([
  'nas_path', 'nasPath', 'internal_url', 'internalUrl', 'actor_email', 'actorEmail',
  'email', 'token', 'secret', 'writeback_key', 'writebackKey'
]);
const PRODUCTION_TARGET_ROLE_ALLOWLIST = {
  admin: new Set(['studiojun_internal', 'studiojun_pd', 'studiojun_artist', 'aive_director', 'aive_ad', 'client_pd', 'abanu_vendor']),
  owner: new Set(['studiojun_internal', 'studiojun_pd', 'studiojun_artist', 'aive_director', 'aive_ad', 'client_pd', 'abanu_vendor']),
  pd: new Set(['studiojun_internal', 'studiojun_pd', 'studiojun_artist', 'aive_director', 'aive_ad', 'client_pd', 'abanu_vendor']),
  producer: new Set(['studiojun_internal', 'studiojun_pd', 'studiojun_artist', 'aive_director', 'aive_ad', 'client_pd', 'abanu_vendor']),
  supervisor: new Set(['studiojun_internal', 'studiojun_artist', 'abanu_vendor']),
  lead: new Set(['studiojun_internal', 'studiojun_artist', 'abanu_vendor']),
  director: new Set(['studiojun_pd', 'studiojun_internal', 'abanu_vendor']),
  reviewer: new Set(['studiojun_pd', 'studiojun_internal']),
  client: new Set(['studiojun_pd', 'studiojun_internal']),
  artist: new Set(['studiojun_internal', 'studiojun_pd']),
  vendor: new Set(['studiojun_internal', 'studiojun_pd']),
  member: new Set(['studiojun_internal', 'studiojun_pd'])
};

function roleOf(user) {
  return String(user?.role || '').toLowerCase();
}

function canManageProduction(user) {
  return INTERNAL_ROLES.has(roleOf(user));
}

function canSuperviseProduction(user) {
  const role = roleOf(user);
  return canManageProduction(user) || SUPERVISOR_ROLES.has(role);
}

function projectFromRequest(req) {
  const url = new URL(req.url);
  return String(url.searchParams.get('project') || url.searchParams.get('project_id') || 'default').trim();
}

function isTboProject(projectId) {
  const key = String(projectId || 'default').trim().toLowerCase();
  return TBO_PROJECT_ALIASES.has(key) || key.includes('tbo') || key.includes('turbo');
}

function actorLabel(user) {
  return user?.email || user?.name || user?.id || 'unknown';
}

function maskEmailForExternal(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at < 1) return value ? '***' : '';
  return value.slice(0, 3) + '***@***';
}

function parseActionLimit(value) {
  const n = parseInt(value || '50', 10);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(n, 200));
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function redactProductionPayload(value) {
  if (Array.isArray(value)) return value.map(redactProductionPayload);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = PRODUCTION_EXTERNAL_REDACT_KEYS.has(key) ? '[redacted]' : redactProductionPayload(nested);
  }
  return output;
}

function normalizeProductionTargetRole(value) {
  return String(value || '').trim().toLowerCase();
}

function canTargetProductionRole(user, targetRole) {
  const target = normalizeProductionTargetRole(targetRole);
  if (!target) return true;
  const allowed = PRODUCTION_TARGET_ROLE_ALLOWLIST[roleOf(user)] || new Set();
  return allowed.has(target);
}

async function initProductionActionsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS production_actions (
    id TEXT PRIMARY KEY,
    project_code TEXT NOT NULL DEFAULT 'TBO',
    episode_code TEXT,
    scene_code TEXT,
    shot_code TEXT,
    asset_code TEXT,
    file_key TEXT,
    action_type TEXT NOT NULL,
    action_status TEXT NOT NULL DEFAULT 'queued',
    actor_user_id TEXT,
    actor_email TEXT,
    actor_role TEXT,
    target_role TEXT,
    source_system TEXT NOT NULL DEFAULT 'production-ui',
    source_ref TEXT,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    error_message TEXT,
    idempotency_key TEXT,
    audit_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  for (const column of [
    ['idempotency_key', 'TEXT'],
    ['audit_hash', 'TEXT']
  ]) {
    try {
      await env.DB.prepare(`ALTER TABLE production_actions ADD COLUMN ${column[0]} ${column[1]}`).run();
    } catch (err) {
      if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
    }
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_production_actions_project_episode ON production_actions(project_code, episode_code, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_production_actions_shot ON production_actions(project_code, episode_code, shot_code, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_production_actions_asset ON production_actions(project_code, asset_code, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_production_actions_status ON production_actions(action_status, action_type, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_production_actions_actor ON production_actions(actor_user_id, created_at)').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_production_actions_idempotency ON production_actions(idempotency_key) WHERE idempotency_key IS NOT NULL').run();
}

function canCreateProductionAction(user, actionType) {
  const role = roleOf(user);
  if (canManageProduction(user)) return true;
  if (MANAGER_ONLY_ACTION_TYPES.has(actionType)) return false;
  if (SUPERVISOR_ROLES.has(role)) return true;
  if (REVIEW_ROLES.has(role)) return REVIEW_ACTION_TYPES.has(actionType);
  if (ARTIST_ROLES.has(role)) return ARTIST_ACTION_TYPES.has(actionType);
  return false;
}

function sanitizeProductionAction(row, viewer) {
  if (canManageProduction(viewer)) return row;
  let payloadJson = row.payload_json;
  try {
    payloadJson = JSON.stringify(redactProductionPayload(JSON.parse(row.payload_json || '{}')));
  } catch (_) {
    payloadJson = '{}';
  }
  return {
    ...row,
    actor_email: maskEmailForExternal(row.actor_email),
    payload_json: payloadJson,
    result_json: null,
    error_message: row.action_status === 'failed' ? 'hidden' : null
  };
}

async function handleProductionActionsAPI(path, req, env) {
  const method = req.method;
  const url = new URL(req.url);
  const segments = path.split('/').filter(Boolean);
  const actionId = segments[3];
  const sub = segments[4];
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  await initProductionActionsTable(env);

  if (path === '/api/production/actions' && method === 'POST') {
    const body = await req.json();
    const projectCode = String(body.projectCode || body.project_code || 'TBO').trim();
    if (!canManageProduction(user) && !isTboProject(projectCode)) {
      return json({ error: 'Forbidden: TURBO ONE access only' }, 403);
    }

    const actionType = String(body.actionType || body.action_type || '').trim();
    if (!PRODUCTION_ACTION_TYPES.has(actionType)) return json({ error: 'Invalid actionType' }, 400);
    if (!canCreateProductionAction(user, actionType)) return json({ error: 'Forbidden actionType for role' }, 403);
    const targetRole = normalizeProductionTargetRole(body.targetRole || body.target_role || '');
    if (!canTargetProductionRole(user, targetRole)) return json({ error: 'Forbidden targetRole for role' }, 403);

    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null;
    if (!payload) return json({ error: 'payload object required' }, 400);
    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > 32768) return json({ error: 'payload too large' }, 413);
    const actorId = user.id || user.email || actorLabel(user);
    const minuteAgo = new Date(Date.now() - 60000).toISOString();
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM production_actions WHERE actor_user_id = ? AND created_at >= ?'
    ).bind(actorId, minuteAgo).first();
    if (Number(recent?.count || 0) >= 60) return json({ error: 'rate limit exceeded' }, 429);

    const rawIdempotencyKey = String(
      req.headers.get('Idempotency-Key') || body.idempotencyKey || body.idempotency_key || ''
    ).trim();
    const idempotencyKey = rawIdempotencyKey ? await sha256Hex(`${actorId}:${actionType}:${rawIdempotencyKey}`) : null;
    if (actionType === 'sheet_write_queued' && !idempotencyKey) {
      return json({ error: 'idempotency key required for sheet_write_queued' }, 400);
    }
    if (idempotencyKey) {
      const existing = await env.DB.prepare(
        'SELECT id, action_status, action_type, created_at FROM production_actions WHERE idempotency_key = ?'
      ).bind(idempotencyKey).first();
      if (existing) {
        return json({ ok: true, action: { id: existing.id, status: existing.action_status, actionType: existing.action_type, createdAt: existing.created_at, idempotent: true } }, 200);
      }
    }

    const id = 'pa_' + Date.now().toString(36) + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const previous = await env.DB.prepare(
      'SELECT audit_hash FROM production_actions WHERE project_code = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(projectCode || 'TBO').first();
    const auditHash = await sha256Hex(JSON.stringify({
      previous: previous?.audit_hash || '',
      id, projectCode, actionType, actorId, targetRole, payloadJson, now
    }));
    await env.DB.prepare(`INSERT INTO production_actions (
      id, project_code, episode_code, scene_code, shot_code, asset_code, file_key,
      action_type, action_status, actor_user_id, actor_email, actor_role, target_role,
      source_system, source_ref, payload_json, idempotency_key, audit_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      projectCode || 'TBO',
      body.episodeCode || body.episode_code || null,
      body.sceneCode || body.scene_code || null,
      body.shotCode || body.shot_code || null,
      body.assetCode || body.asset_code || null,
      body.fileKey || body.file_key || null,
      actionType,
      actorId,
      user.email || null,
      roleOf(user),
      targetRole || null,
      body.sourceSystem || body.source_system || 'production-ui',
      body.sourceRef || body.source_ref || null,
      payloadJson,
      idempotencyKey,
      auditHash,
      now,
      now
    ).run();

    return json({ ok: true, action: { id, status: 'queued', actionType, createdAt: now } }, 201);
  }

  if (path === '/api/production/actions' && method === 'GET') {
    const projectCode = String(url.searchParams.get('projectCode') || url.searchParams.get('project_code') || 'TBO').trim();
    if (!canManageProduction(user) && !isTboProject(projectCode)) {
      return json({ error: 'Forbidden: TURBO ONE access only' }, 403);
    }

    const clauses = ['project_code = ?'];
    const params = [projectCode || 'TBO'];
    const filterMap = [
      ['episodeCode', 'episode_code'],
      ['episode_code', 'episode_code'],
      ['shotCode', 'shot_code'],
      ['shot_code', 'shot_code'],
      ['actionType', 'action_type'],
      ['action_type', 'action_type'],
      ['status', 'action_status']
    ];
    for (const [queryKey, column] of filterMap) {
      const value = url.searchParams.get(queryKey);
      if (value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(parseActionLimit(url.searchParams.get('limit')));
    const rows = await env.DB.prepare(
      `SELECT * FROM production_actions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
    ).bind(...params).all();

    return json({ ok: true, actions: (rows.results || []).map(row => sanitizeProductionAction(row, user)) });
  }

  if (actionId && sub === 'status' && method === 'PATCH') {
    if (!canManageProduction(user)) return json({ error: 'Admin/PD only' }, 403);
    const body = await req.json();
    const status = String(body.status || '').trim();
    if (!['queued', 'synced', 'failed'].includes(status)) return json({ error: 'Invalid status' }, 400);
    const resultJson = body.result && typeof body.result === 'object' ? JSON.stringify(body.result) : null;
    const errorMessage = body.error || body.errorMessage || null;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE production_actions
       SET action_status = ?, result_json = ?, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).bind(status, resultJson, errorMessage, now, actionId).run();
    return json({ ok: true, action: { id: actionId, status, updatedAt: now } });
  }

  return json({ error: 'Production actions API route not found' }, 404);
}

async function getRequestUser(req, env) {
  if (req.sjUser) return req.sjUser;
  const user = await authenticateAny(req, env);
  req.sjUser = user;
  return user;
}

async function initAiTaskQueueTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_task_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT DEFAULT 'prj_tbo_s1',
    task_type TEXT NOT NULL CHECK(task_type IN ('translate', 'direction_guide', 'term_glossary', 'scene_analysis', 'script_review')),
    engine TEXT NOT NULL DEFAULT 'dispatch' CHECK(engine IN ('api', 'dispatch')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'error')),
    source_lang TEXT DEFAULT 'ko',
    target_lang TEXT DEFAULT 'en',
    input_text TEXT NOT NULL,
    context TEXT,
    output_text TEXT,
    requested_by TEXT,
    entity_type TEXT,
    entity_id TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    completed_at INTEGER,
    error_message TEXT
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ai_task_queue_pending ON ai_task_queue(engine, status, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ai_task_queue_entity ON ai_task_queue(entity_type, entity_id, created_at)').run();
}

function canUseAiTaskQueue(user) {
  const role = roleOf(user);
  return canManageProduction(user) || SUPERVISOR_ROLES.has(role) || REVIEW_ROLES.has(role);
}

function normalizeAiTaskType(value) {
  const taskType = String(value || 'translate').trim();
  const allowed = new Set(['translate', 'direction_guide', 'term_glossary', 'scene_analysis', 'script_review']);
  return allowed.has(taskType) ? taskType : null;
}

function buildAiTaskPrompt(task) {
  const langNames = { ko: 'Korean', en: 'English', vi: 'Vietnamese' };
  const target = langNames[task.target_lang] || task.target_lang || 'English';
  const source = langNames[task.source_lang] || task.source_lang || 'Korean';
  const context = task.context || 'TURBO ONE 3D animation production';
  const base = `You are a senior 3D animation production assistant for STUDIOJUN's TURBO ONE project.
Preserve shot codes, asset names, frame numbers, version names, file names, software names, and pipeline terms.
Use professional animation terminology for Maya, layout, blocking, spline, polish, timing, spacing, arcs, silhouette, camera, lighting, render, compositing, FX, cache, and playblast.
Return only the requested result without extra preface.`;

  if (task.task_type === 'translate') {
    return {
      system: base,
      user: `<task>Translate production feedback.</task>
<source_language>${source}</source_language>
<target_language>${target}</target_language>
<context>${context}</context>
<text>${task.input_text}</text>`
    };
  }
  if (task.task_type === 'direction_guide') {
    return {
      system: base,
      user: `<task>Create concise shot direction guidance for animators.</task>
<target_language>${target}</target_language>
<context>${context}</context>
<notes>${task.input_text}</notes>`
    };
  }
  if (task.task_type === 'term_glossary') {
    return {
      system: base,
      user: `<task>Convert the Korean feedback into a bilingual animation terminology glossary.</task>
<target_language>${target}</target_language>
<context>${context}</context>
<terms>${task.input_text}</terms>`
    };
  }
  if (task.task_type === 'scene_analysis') {
    return {
      system: base,
      user: `<task>Analyze this scene/cut note for production planning.</task>
<target_language>${target}</target_language>
<context>${context}</context>
<scene_notes>${task.input_text}</scene_notes>`
    };
  }
  return {
    system: base,
    user: `<task>Review this script or production note for animation risks and actionable fixes.</task>
<target_language>${target}</target_language>
<context>${context}</context>
<script_or_note>${task.input_text}</script_or_note>`
  };
}

async function runAiTaskApiMode(env, task) {
  const prompt = buildAiTaskPrompt(task);
  const model = task.task_type === 'translate' || task.task_type === 'term_glossary'
    ? 'claude-haiku-4-5-20251001'
    : 'claude-sonnet-4-6';
  const result = await callClaude(env, model, prompt.system, prompt.user, 800);
  return {
    outputText: result.content?.[0]?.text || '',
    model,
    usage: result.usage || null
  };
}

async function handleAiTaskAPI(path, req, env) {
  const method = req.method;
  const url = new URL(req.url);
  const segments = path.split('/').filter(Boolean);
  const id = segments[2];
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if (!canUseAiTaskQueue(user)) return json({ error: 'Forbidden' }, 403);

  await initAiTaskQueueTable(env);

  if (path === '/api/ai-task' && method === 'POST') {
    const body = await req.json();
    const taskType = normalizeAiTaskType(body.task_type || body.taskType);
    if (!taskType) return json({ error: 'Invalid task_type' }, 400);
    const engine = String(body.engine || 'dispatch').trim() === 'api' ? 'api' : 'dispatch';
    const inputText = String(body.input_text || body.inputText || body.text || '').trim();
    if (!inputText) return json({ error: 'input_text required' }, 400);
    if (inputText.length > 24000) return json({ error: 'input_text too large' }, 413);
    const task = {
      project_id: String(body.project_id || body.projectId || 'prj_tbo_s1'),
      task_type: taskType,
      engine,
      status: engine === 'api' ? 'processing' : 'pending',
      source_lang: String(body.source_lang || body.sourceLang || 'ko'),
      target_lang: String(body.target_lang || body.targetLang || 'en'),
      input_text: inputText,
      context: typeof body.context === 'string' ? body.context : JSON.stringify(body.context || {}),
      requested_by: user.id || user.email || actorLabel(user),
      entity_type: body.entity_type || body.entityType || null,
      entity_id: body.entity_id || body.entityId || null
    };
    const now = Date.now();
    const inserted = await env.DB.prepare(`INSERT INTO ai_task_queue (
      project_id, task_type, engine, status, source_lang, target_lang, input_text,
      context, requested_by, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      task.project_id, task.task_type, task.engine, task.status, task.source_lang, task.target_lang,
      task.input_text, task.context, task.requested_by, task.entity_type, task.entity_id, now
    ).run();
    const taskId = inserted.meta?.last_row_id;
    if (engine === 'dispatch') {
      return json({ ok: true, id: taskId, status: 'pending', engine: 'dispatch', created_at: now }, 201);
    }

    try {
      const apiResult = await runAiTaskApiMode(env, task);
      await env.DB.prepare(
        'UPDATE ai_task_queue SET status = ?, output_text = ?, completed_at = ? WHERE id = ?'
      ).bind('done', apiResult.outputText, Date.now(), taskId).run();
      return json({ ok: true, id: taskId, status: 'done', engine: 'api', output_text: apiResult.outputText, model: apiResult.model, usage: apiResult.usage }, 201);
    } catch (err) {
      await env.DB.prepare(
        'UPDATE ai_task_queue SET status = ?, error_message = ?, completed_at = ? WHERE id = ?'
      ).bind('error', String(err?.message || err), Date.now(), taskId).run();
      return json({ ok: false, id: taskId, status: 'error', error: String(err?.message || err) }, 502);
    }
  }

  if (path === '/api/ai-task/pending' && method === 'GET') {
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 50));
    const rows = await env.DB.prepare(
      `SELECT id, project_id, task_type, engine, status, source_lang, target_lang, input_text,
              context, requested_by, entity_type, entity_id, created_at
       FROM ai_task_queue
       WHERE engine = 'dispatch' AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`
    ).bind(limit).all();
    return json({ ok: true, tasks: rows.results || [] });
  }

  if (id && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM ai_task_queue WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'AI task not found' }, 404);
    return json({ ok: true, task: row });
  }

  if (id && method === 'PATCH') {
    const body = await req.json();
    const status = String(body.status || '').trim();
    if (!['processing', 'done', 'error'].includes(status)) return json({ error: 'Invalid status' }, 400);
    const outputText = body.output_text || body.outputText || null;
    const errorMessage = body.error_message || body.errorMessage || body.error || null;
    await env.DB.prepare(
      `UPDATE ai_task_queue
       SET status = ?, output_text = COALESCE(?, output_text), error_message = COALESCE(?, error_message),
           completed_at = CASE WHEN ? IN ('done', 'error') THEN ? ELSE completed_at END
       WHERE id = ?`
    ).bind(status, outputText, errorMessage, status, Date.now(), id).run();
    const row = await env.DB.prepare('SELECT * FROM ai_task_queue WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'AI task not found' }, 404);
    return json({ ok: true, task: row });
  }

  return json({ error: 'AI task route not found' }, 404);
}

async function handleHiggsfieldAPI(path, req, env) {
  const method = req.method;
  const url = new URL(req.url);
  const segments = path.split('/').filter(Boolean);
  const resource = segments[2];
  const id = segments[3];

  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if (resource !== 'jobs') return json({ error: 'Higgsfield route not found' }, 404);
  if (!env.DB) return json({ error: 'D1 DB binding missing' }, 500);

  if (method === 'GET' && id) {
    try {
      const row = await env.DB.prepare(
        `SELECT id, type, model, prompt, status, aspect_ratio, resolution, quality,
                result_url, thumbnail_url, source_job_id, params, created_at,
                completed_at, project, episode, shot, description
           FROM higgsfield_jobs
          WHERE id = ?`
      ).bind(id).first();
      if (!row) return json({ error: 'Job not found' }, 404);
      return json({ item: normalizeHiggsfieldJob(row) });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  if (method === 'GET') {
    const rawLimit = parseInt(url.searchParams.get('limit') || '100', 10);
    const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 200));
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');
    const project = url.searchParams.get('project') || 'TBO';
    const filters = ['project = ?'];
    const values = [project];

    if (type) {
      filters.push('type = ?');
      values.push(type);
    }
    if (status) {
      filters.push('status = ?');
      values.push(status);
    }

    const where = `WHERE ${filters.join(' AND ')}`;
    try {
      const countRow = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM higgsfield_jobs ${where}`
      ).bind(...values).first();
      const rows = await env.DB.prepare(
        `SELECT id, type, model, prompt, status, aspect_ratio, resolution, quality,
                result_url, thumbnail_url, source_job_id, params, created_at,
                completed_at, project, episode, shot, description
           FROM higgsfield_jobs
           ${where}
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ? OFFSET ?`
      ).bind(...values, limit, offset).all();
      const items = (rows.results || []).map(normalizeHiggsfieldJob);
      return json({ items, generations: items, total: countRow?.total || 0, limit, offset });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

function normalizeHiggsfieldJob(row) {
  let params = null;
  if (row.params) {
    try { params = JSON.parse(row.params); } catch { params = row.params; }
  }
  return {
    id: row.id,
    type: row.type,
    model: row.model,
    prompt: row.prompt,
    status: row.status,
    aspect_ratio: row.aspect_ratio,
    resolution: row.resolution,
    quality: row.quality,
    result_url: row.result_url,
    thumbnail_url: row.thumbnail_url || row.result_url,
    source_job_id: row.source_job_id,
    params,
    created_at: row.created_at,
    completed_at: row.completed_at,
    project: row.project,
    episode: row.episode,
    shot: row.shot,
    description: row.description
  };
}

async function enforceProductionApiAccess(resource, method, req, env) {
  if (!PRODUCTION_API_RESOURCES.has(resource)) return null;
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const role = roleOf(user);
  const projectId = projectFromRequest(req);
  if (!canManageProduction(user) && !isTboProject(projectId)) {
    return json({ error: 'Forbidden: TURBO ONE access only' }, 403);
  }

  if (resource === 'members') {
    if (method === 'GET') return null;
    return canManageProduction(user) ? null : json({ error: 'Admin/PD only' }, 403);
  }

  if (resource === 'projects') {
    if (method === 'GET') return null;
    return canManageProduction(user) ? null : json({ error: 'Admin/PD only' }, 403);
  }

  if (resource === 'stats' || resource === 'activity' || resource === 'pipeline') return null;

  if (resource === 'assets') {
    if (method === 'GET') return null;
    return canSuperviseProduction(user) ? null : json({ error: 'Supervisor or Producer only' }, 403);
  }

  if (resource === 'shots' || resource === 'todos') {
    if (method === 'GET') return null;
    if (REVIEW_ROLES.has(role) && method !== 'GET') return json({ error: 'Read/comment access only' }, 403);
    return null;
  }

  if (resource === 'reviews' || resource === 'comments' || resource === 'messages') {
    if (method === 'DELETE') return canManageProduction(user) ? null : json({ error: 'Admin/PD only' }, 403);
    return null;
  }

  if (resource === 'files') {
    if (method === 'GET') return null;
    if (role === 'client') return json({ error: 'Client cannot upload production files' }, 403);
    return null;
  }

  if (resource === 'nas' || resource === 'folder') {
    if (method === 'GET') return null;
    return canManageProduction(user) ? null : json({ error: 'Admin/PD only' }, 403);
  }

  if (ARTIST_ROLES.has(role) || REVIEW_ROLES.has(role) || canSuperviseProduction(user)) return null;
  return json({ error: 'Forbidden' }, 403);
}

async function handleAPI(path, req, env) {
  const method = req.method;
  const segments = path.split('/').filter(Boolean);
  const resource = segments[1];
  const id = segments[2];
  const sub = segments[3];

  // Auth
  if (path === '/api/auth/login' && method === 'POST') return login(req, env);
  if (path === '/api/auth/register' && method === 'POST') return register(req, env);
  if (path === '/api/auth/me' && method === 'GET') return getMe(req, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(req, env);
  if (path === '/api/auth/firebase-verify' && method === 'POST') return firebaseVerify(req, env);
  if (path === '/api/auth/request-access' && method === 'POST') return requestAccess(req, env);

  if (resource === 'ai-task') return handleAiTaskAPI(path, req, env);

  if (resource === 'production' && id === 'actions') return handleProductionActionsAPI(path, req, env);

  const gate = await enforceProductionApiAccess(resource, method, req, env);
  if (gate) return gate;

  // Invites (admin only)
  if (path === '/api/invites' && method === 'GET') return listInvites(req, env);
  if (path === '/api/invites' && method === 'POST') return createInvite(req, env);
  if (resource === 'invites' && id && method === 'DELETE') return deleteInvite(id, req, env);
  if (path === '/api/invites/verify' && method === 'POST') return verifyInviteCode(req, env);

  // API Tokens
  if (path === '/api/tokens' && method === 'GET') return listTokens(req, env);
  if (path === '/api/tokens' && method === 'POST') return createToken(req, env);
  if (resource === 'tokens' && id && method === 'DELETE') return deleteToken(id, req, env);

  // Reports (structured JSON for Claude Code)
  if (path === '/api/reports/daily' && method === 'GET') return getStructuredReport(req, env, 'daily');
  if (path === '/api/reports/weekly' && method === 'GET') return getStructuredReport(req, env, 'weekly');
  if (resource === 'reports' && id === 'team' && sub) return getTeamReport(sub, req, env);

  // TBO Dashboard
  if (path === '/api/tbo/dashboard' && method === 'GET') return getTBODashboard(env);

  // Pipeline
  if (resource === 'pipeline') {
    if (method === 'GET') return getPipelineStatus(req, env);
  }

  // Shots
  if (resource === 'shots') {
    if (method === 'GET' && !id) return getShots(req, env);
    if (method === 'GET' && id) return getShot(id, env);
    if (method === 'POST') return createShot(req, env);
    if (method === 'PUT' && id) return updateShot(id, req, env);
    if (method === 'DELETE' && id) return deleteShot(id, req, env);
  }

  // Assets
  if (resource === 'assets') {
    if (method === 'GET' && !id) return getAssets(req, env);
    if (method === 'POST') return createAsset(req, env);
    if (method === 'PUT' && id) return updateAsset(id, req, env);
    if (method === 'DELETE' && id) return deleteAsset(id, req, env);
  }

  // Todos
  if (resource === 'todos') {
    if (method === 'GET' && !id) return getTodos(req, env);
    if (method === 'POST') return createTodo(req, env);
    if (method === 'PUT' && id) return updateTodo(id, req, env);
    if (method === 'DELETE' && id) return deleteTodo(id, req, env);
  }

  // Comments
  if (resource === 'comments') {
    if (method === 'GET') return getComments(req, env);
    if (method === 'POST') return createComment(req, env);
  }

  // Messages
  if (resource === 'messages') {
    if (method === 'GET') return getMessages(req, env);
    if (method === 'POST') return createMessage(req, env);
  }

  // Projects
  if (resource === 'projects') {
    if (method === 'GET' && !id) return getProjects(env);
    if (method === 'GET' && id && sub === 'stats') return getProjectStats(id, env);
    if (method === 'GET' && id) return getProject(id, env);
    if (method === 'POST' && id && sub === 'switch') return switchProject(id, req, env);
    if (method === 'POST') return createProject(req, env);
    if (method === 'PUT' && id) return updateProject(id, req, env);
    if (method === 'DELETE' && id) return archiveProject(id, req, env);
  }

  // Members
  if (resource === 'members') {
    if (method === 'GET') return getMembers(req, env);
    if (method === 'POST') return createMember(req, env);
    if (method === 'PUT' && id) return updateMember(id, req, env);
  }

  // Stats
  if (resource === 'stats') return getStats(req, env);
  if (resource === 'activity') return getActivity(req, env);

  // Video Reviews
  if (resource === 'reviews') {
    if (method === 'GET' && !id) return getReviews(req, env);
    if (method === 'GET' && id && sub === 'comments') return getReviewComments(id, env);
    if (method === 'POST' && !id) return createReview(req, env);
    if (method === 'POST' && id && sub === 'comments') return createReviewComment(id, req, env);
    if (method === 'PUT' && id) return updateReview(id, req, env);
  }

  // File upload/download (legacy)
  if (resource === 'files') {
    if (method === 'POST') return uploadFile(req, env);
    if (method === 'GET' && id) return downloadFile(id, env);
  }

  // Bulk state
  if (path === '/api/state/load' && method === 'GET') return loadState(req, env);
  if (path === '/api/state/save' && method === 'POST') return saveState(req, env);
  if (path === '/api/notifications' && method === 'GET') return getNotifications(req, env);
  if (path === '/api/notifications' && method === 'POST') return createNotification(req, env);
  if (path === '/api/notifications/read-all' && method === 'POST') return readAllNotifications(req, env);

  // ===== NAS API (CF Tunnel ??Synology File Station) =====
  if (path === '/api/nas/status' && method === 'GET') return nasStatus(env);
  if (path === '/api/nas/list' && method === 'GET') return nasList(req, env);
  if (path === '/api/nas/scan' && method === 'POST') return nasScan(req, env);
  if (path === '/api/nas/scan/latest' && method === 'GET') return nasScanLatest(env);
  if (resource === 'nas' && id === 'scan' && sub && method === 'GET') return nasScanGet(sub, env);
  if (path === '/api/nas/ingest' && method === 'POST') return nasIngestVersion(req, env);

  // Folder Links (NAS path metadata)
  if (resource === 'folder' && segments[2] === 'links') {
    const linkId = segments[3];
    if (method === 'GET' && !linkId) return folderLinksList(req, env);
    if (method === 'GET' && linkId) return folderLinksGet(linkId, env);
    if (method === 'POST' && !linkId) return folderLinksCreate(req, env);
    if (method === 'PUT' && linkId) return folderLinksUpdate(linkId, req, env);
    if (method === 'DELETE' && linkId) return folderLinksDelete(linkId, env);
  }

  // Storage mode resolver
  if (path === '/api/storage/mode' && method === 'GET') return storageMode(req);

  return json({ error: 'Not found' }, 404);
}

// ===== Firebase Token Verification (JWK 諛⑹떇) =====
let _googleJwkCache = null;
let _googleJwkCacheTime = 0;

async function getGoogleJwks() {
  if (_googleJwkCache && Date.now() - _googleJwkCacheTime < 3600000) return _googleJwkCache;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const data = await res.json();
  const keyMap = {};
  for (const key of data.keys) {
    keyMap[key.kid] = key;
  }
  _googleJwkCache = keyMap;
  _googleJwkCacheTime = Date.now();
  return keyMap;
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function base64UrlDecodeUtf8(str) {
  const binary = base64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function verifyFirebaseToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const header = JSON.parse(base64UrlDecodeUtf8(parts[0]));
  const payload = JSON.parse(base64UrlDecodeUtf8(parts[1]));

  // 湲곕낯 寃利?
  if (header.alg !== 'RS256') throw new Error('Invalid algorithm');
  if (payload.aud !== projectId) throw new Error('Invalid audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Invalid issuer');
  if (payload.exp * 1000 < Date.now()) throw new Error('Token expired');

  // JWK 怨듦컻?ㅻ줈 ?쒕챸 寃利?
  const keys = await getGoogleJwks();
  const jwk = keys[header.kid];
  if (!jwk) throw new Error('Key not found for kid: ' + header.kid);

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);

  const signatureBytes = Uint8Array.from(base64UrlDecode(parts[2]), c => c.charCodeAt(0));
  const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, dataBytes);
  if (!valid) throw new Error('Invalid signature');

  return payload;
}

async function firebaseVerify(req, env) {
  const { id_token } = await req.json();
  if (!id_token) return json({ error: 'id_token required' }, 400);

  try {
    const firebaseProjectId = env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;
    const payload = await verifyFirebaseToken(id_token, firebaseProjectId);
    const uid = payload.sub;
    const email = payload.email;
    const normalizedEmail = String(email || '').toLowerCase();
    const ownerEmails = ['studiojun4347@gmail.com', 'lch4347@gmail.com'];

    // D1?먯꽌 ?ъ슜??議고쉶 (firebase_uid濡?
    let member = await env.DB.prepare('SELECT * FROM members WHERE firebase_uid = ?').bind(uid).first();

    if (!member) {
      // ?대찓?쇰줈 議고쉶 (湲곗〈 硫ㅻ쾭 ?곌껐)
      member = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(email).first();
      if (member) {
        await env.DB.prepare('UPDATE members SET firebase_uid = ? WHERE id = ?').bind(uid, member.id).run();
      } else if (ownerEmails.includes(normalizedEmail)) {
        const id = 'MEM_OWNER';
        const name = payload.name || 'JUN';
        const initials = name.substring(0, 2);
        await env.DB.prepare(
          'INSERT OR REPLACE INTO members (id, name, email, firebase_uid, role, team, initials) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, email, uid, 'admin', 'all', initials).run();
        member = { id, name, email, role: 'admin', team: 'all', initials };
      } else {
        // 珥덈????대찓?쇱씤吏 ?뺤씤
        await ensureInvitesTable(env);
        const invite = await env.DB.prepare(
          'SELECT * FROM invites WHERE email = ? AND used = 0'
        ).bind(email).first();
        if (!invite) return json({ error: '珥덈??섏? ?딆? ?대찓?쇱엯?덈떎. 愿由ъ옄?먭쾶 珥덈?瑜??붿껌?섏꽭??' }, 403);

        // 珥덈???硫ㅻ쾭 ?앹꽦
        const id = 'MEM_' + Date.now().toString(36);
        const name = payload.name || email.split('@')[0];
        const role = invite.role || 'member';
        const team = invite.team || 'all';
        await env.DB.prepare(
          'INSERT INTO members (id, name, email, firebase_uid, role, team, initials) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, email, uid, role, team, name.substring(0, 2)).run();
        member = { id, name, email, role, team, initials: name.substring(0, 2) };

        // Mark invite as used
        await markInviteUsed(env, invite.invite_code, id);
      }
    }

    const token = await createJWT({ id: member.id, role: member.role, team: member.team }, env.JWT_SECRET);
    return jsonWithCookie({
      token,
      user: { id: member.id, name: member.name, role: member.role, team: member.team, initials: member.initials, email: member.email }
    }, token);
  } catch (e) {
    return json({ error: 'Firebase token verification failed: ' + e.message }, 401);
  }
}

// ===== API Token Management (for Claude Code) =====
async function listTokens(req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);

  // Admin sees all tokens (with owner info)
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.user_id, t.name, t.permissions, t.last_used_at, t.expires_at, t.created_at,
            m.name as owner_name, m.role as owner_role
     FROM api_tokens t LEFT JOIN members m ON t.user_id = m.id
     ORDER BY t.created_at DESC`
  ).all();
  return json(results);
}

async function createToken(req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);

  const { name, permissions, target_user_id } = await req.json();
  const ownerId = target_user_id || user.id;

  // If creating for another user, verify they exist
  if (target_user_id && target_user_id !== user.id) {
    const target = await env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(target_user_id).first();
    if (!target) return json({ error: 'Target user not found' }, 404);
  }

  const tokenValue = 'sj_' + crypto.randomUUID().replace(/-/g, '');
  const hash = await hashTokenValue(tokenValue);
  const id = 'TOK_' + Date.now().toString(36);

  await env.DB.prepare(
    'INSERT INTO api_tokens (id, user_id, name, token_hash, permissions, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, ownerId, name || 'API Token', hash, JSON.stringify(permissions || ['read', 'write', 'ai']), Date.now() + 365 * 24 * 60 * 60 * 1000).run();

  return json({ id, token: tokenValue, name, owner_id: ownerId, message: '???좏겙???덉쟾?섍쾶 蹂닿??섏꽭?? ?ㅼ떆 ?쒖떆?섏? ?딆뒿?덈떎.' }, 201);
}

async function deleteToken(id, req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);
  await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
  return json({ deleted: id });
}

async function hashTokenValue(token) {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function authenticateByApiToken(req, env) {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer sj_')) return null;
  const tokenValue = auth.slice(7);
  const hash = await hashTokenValue(tokenValue);
  const token = await env.DB.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').bind(hash).first();
  if (!token) return null;
  if (token.expires_at && token.expires_at < Date.now()) return null;

  // 留덉?留??ъ슜 ?쒓컙 ?낅뜲?댄듃
  await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), token.id).run();

  const member = await env.DB.prepare('SELECT id, name, role, team FROM members WHERE id = ?').bind(token.user_id).first();
  if (!member) return null;
  member.permissions = JSON.parse(token.permissions || '["read"]');
  return member;
}

// JWT ?먮뒗 API ?좏겙?쇰줈 ?몄쬆
async function authenticateAny(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer sj_')) return authenticateByApiToken(req, env);
  return authenticate(req, env);
}

function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function isPrivilegedRole(role, adminOnly = false) {
  const normalized = String(role || '').toLowerCase();
  if (adminOnly) return normalized === 'admin' || normalized === 'owner';
  return ['admin', 'owner', 'pd', 'producer'].includes(normalized);
}

async function requireAdmin(request, env, options = {}) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && env.ADMIN_DEPLOY_KEY) {
    const presented = auth.slice(7);
    if (timingSafeEqual(presented, env.ADMIN_DEPLOY_KEY)) {
      return { kind: 'service', role: 'admin' };
    }
  }
  const user = await authenticateAny(request, env);
  if (!user) return null;
  return isPrivilegedRole(user.role, !!options.adminOnly)
    ? { kind: 'user', user, role: String(user.role || '').toLowerCase() }
    : null;
}

async function requireAdminForPath(path, request, env) {
  if (!(path.startsWith('/admin/') || path.startsWith('/api/admin/'))) return null;
  const adminOnly = path.includes('/deploy-self') || path.includes('/deploy-worker') || path === '/admin/seed';
  const auth = await requireAdmin(request, env, { adminOnly });
  if (!auth) return json({ error: 'Unauthorized' }, 401);
  return null;
}

function requireDeployConfirm(request) {
  if (request.headers.get('X-Confirm-Deploy') === 'yes') return null;
  return json({ error: 'Deploy confirmation required', required_header: 'X-Confirm-Deploy: yes' }, 400);
}

function isAllowedDeploySourceUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.origin === 'https://studiojun.co.kr' || parsed.origin === 'https://www.studiojun.co.kr') return true;
    return parsed.hostname.endsWith('.r2.cloudflarestorage.com') || parsed.hostname.endsWith('.r2.dev');
  } catch {
    return false;
  }
}

function isAllowedR2UploadKey(key) {
  return /^(deploy|modules|production-ui)\//.test(String(key || '')) && !String(key || '').includes('..');
}

function isAllowedSeedSql(sql) {
  const statement = String(sql || '').trim();
  if (!statement) return false;
  if (/(^|[\s;])(DROP|ATTACH|PRAGMA|DELETE|ALTER|TRUNCATE)\b/i.test(statement)) return false;
  if (/;[\s-]*--/.test(statement)) return false;
  return /^(INSERT|UPDATE|CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS)\b/i.test(statement);
}

// ===== Structured Reports (for Claude Code) =====
async function getStructuredReport(req, env, type) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';
  const ctx = await getProjectContext(env, projectId);

  const timeFilter = type === 'daily'
    ? Date.now() - 24 * 60 * 60 * 1000
    : Date.now() - 7 * 24 * 60 * 60 * 1000;

  const { results: recentChanges } = await env.DB.prepare(
    'SELECT * FROM activity_log WHERE project_id = ? AND created_at > ? ORDER BY created_at DESC'
  ).bind(projectId, timeFilter).all();

  const { results: completedShots } = await env.DB.prepare(
    "SELECT id, scene, team, assignee FROM shots WHERE project_id = ? AND status = 'done' AND updated_at > ?"
  ).bind(projectId, timeFilter).all();

  const { results: overdue } = await env.DB.prepare(
    "SELECT id, scene, team, assignee, due FROM shots WHERE project_id = ? AND due != '' AND due < date('now') AND status NOT IN ('done')"
  ).bind(projectId).all();

  return json({
    type,
    period: type === 'daily' ? new Date().toISOString().slice(0, 10) : `Week ${Math.ceil(new Date().getDate() / 7)}`,
    stats: ctx.stats,
    teamStats: ctx.teamStats,
    epStats: ctx.epStats,
    assigneeLoad: ctx.assigneeLoad,
    recentActivity: recentChanges.length,
    completedShots: completedShots.length,
    completedShotsList: completedShots,
    overdueShots: overdue,
    generatedAt: new Date().toISOString()
  });
}

async function getTeamReport(team, req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';

  const { results: shots } = await env.DB.prepare(
    'SELECT * FROM shots WHERE project_id = ? AND team = ? ORDER BY scene'
  ).bind(projectId, team).all();

  const stats = {
    total: shots.length,
    done: shots.filter(s => s.status === 'done').length,
    production: shots.filter(s => s.status === 'production').length,
    confirm: shots.filter(s => s.status === 'confirm').length,
    hold: shots.filter(s => s.status === 'hold').length,
    pending: shots.filter(s => s.status === 'pending').length
  };

  const assignees = {};
  for (const s of shots) {
    if (s.assignee) {
      if (!assignees[s.assignee]) assignees[s.assignee] = { total: 0, done: 0, production: 0 };
      assignees[s.assignee].total++;
      if (s.status === 'done') assignees[s.assignee].done++;
      if (s.status === 'production') assignees[s.assignee].production++;
    }
  }

  return json({ team, stats, assignees, shots: shots.slice(0, 50), generatedAt: new Date().toISOString() });
}

// ===== Invite System =====
async function ensureInvitesTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT 'member',
    team TEXT DEFAULT 'all',
    invited_by TEXT,
    used INTEGER DEFAULT 0,
    used_by TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    used_at INTEGER
  )`).run();
}

async function listInvites(req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);
  await ensureInvitesTable(env);
  const { results } = await env.DB.prepare('SELECT * FROM invites ORDER BY created_at DESC').all();
  return json(results);
}

async function createInvite(req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);
  await ensureInvitesTable(env);

  const { email, role, team } = await req.json();
  if (!email) return json({ error: 'email required' }, 400);

  // Check if already invited
  const existing = await env.DB.prepare('SELECT id FROM invites WHERE email = ? AND used = 0').bind(email).first();
  if (existing) return json({ error: '?대? 珥덈????대찓?쇱엯?덈떎' }, 409);

  // Check if already a member
  const member = await env.DB.prepare('SELECT id FROM members WHERE email = ?').bind(email).first();
  if (member) return json({ error: '?대? ?깅줉??硫ㅻ쾭?낅땲?' }, 409);

  const id = 'INV_' + Date.now().toString(36);
  const invite_code = crypto.randomUUID().replace(/-/g, '').substring(0, 12).toUpperCase();

  await env.DB.prepare(
    'INSERT INTO invites (id, email, invite_code, role, team, invited_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, email, invite_code, role || 'member', team || 'all', user.id).run();

  return json({ id, email, invite_code, role: role || 'member', team: team || 'all' }, 201);
}

async function deleteInvite(id, req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);
  await ensureInvitesTable(env);
  await env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(id).run();
  return json({ success: true });
}

async function verifyInviteCode(req, env) {
  await ensureInvitesTable(env);
  const { code, email } = await req.json();
  if (!code) return json({ error: 'code required' }, 400);

  const invite = await env.DB.prepare(
    'SELECT * FROM invites WHERE invite_code = ? AND used = 0'
  ).bind(code).first();

  if (!invite) return json({ error: '?좏슚?섏? ?딆? 珥덈? 肄붾뱶?낅땲?' }, 404);
  if (email && invite.email !== email) return json({ error: '珥덈????대찓?쇨낵 ?쇱튂?섏? ?딆뒿?덈떎' }, 403);

  return json({ valid: true, email: invite.email, role: invite.role, team: invite.team });
}

async function markInviteUsed(env, code, userId) {
  await env.DB.prepare(
    'UPDATE invites SET used = 1, used_by = ?, used_at = unixepoch() WHERE invite_code = ?'
  ).bind(userId, code).run();
}

// ===== Auth =====
async function login(req, env) {
  const { email, password } = await req.json();
  const member = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(email).first();
  if (!member) return json({ error: '?대찓???먮뒗 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎' }, 401);
  if (!member.password_hash) return json({ error: 'Firebase 濡쒓렇?몄쓣 ?ъ슜?섏꽭?' }, 400);

  const valid = await verifyPassword(password, member.password_hash);
  if (!valid) return json({ error: '?대찓???먮뒗 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎' }, 401);

  const token = await createJWT({ id: member.id, role: member.role, team: member.team }, env.JWT_SECRET);
  return jsonWithCookie({ token, user: { id: member.id, name: member.name, role: member.role, team: member.team, initials: member.initials } }, token);
}

async function register(req, env) {
  const { name, email, password, invite_code, initials } = await req.json();
  if (!name || !email || !password) return json({ error: '?꾩닔 ??ぉ???낅젰?섏꽭?' }, 400);
  if (!invite_code) return json({ error: '珥덈? 肄붾뱶媛 ?꾩슂?⑸땲?' }, 400);

  // Verify invite code
  await ensureInvitesTable(env);
  const invite = await env.DB.prepare(
    'SELECT * FROM invites WHERE invite_code = ? AND used = 0'
  ).bind(invite_code).first();
  if (!invite) return json({ error: '?좏슚?섏? ?딆? 珥덈? 肄붾뱶?낅땲?' }, 403);
  if (invite.email !== email) return json({ error: '珥덈????대찓?쇨낵 ?쇱튂?섏? ?딆뒿?덈떎' }, 403);

  const existing = await env.DB.prepare('SELECT id FROM members WHERE email = ?').bind(email).first();
  if (existing) return json({ error: '?대? ?깅줉???대찓?쇱엯?덈떎' }, 409);

  const id = 'MEM_' + Date.now().toString(36);
  const hash = await hashPassword(password);
  const role = invite.role || 'member';
  const team = invite.team || 'all';
  await env.DB.prepare(
    'INSERT INTO members (id, name, email, password_hash, role, team, initials) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, email, hash, role, team, initials || name.substring(0, 2)).run();

  // Mark invite as used
  await markInviteUsed(env, invite_code, id);

  const token = await createJWT({ id, role, team }, env.JWT_SECRET);
  return jsonWithCookie({ token, user: { id, name, role, team, initials: initials || name.substring(0, 2) } }, token, 201);
}

// ===== 媛???뱀씤 ?붿껌 (怨듦컻 ???몄쬆 遺덊븘?? =====
async function requestAccess(req, env) {
  const { name, email, position, team, message } = await req.json();
  if (!name || !email || !position) return json({ error: '?대쫫, ?대찓?? ?ъ??섏쓣 紐⑤몢 ?낅젰?섏꽭?' }, 400);

  // ?대찓???뺤떇 寃利?
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '?щ컮瑜??대찓???뺤떇???꾨떃?덈떎' }, 400);

  // ?대? ?깅줉???대찓???뺤씤
  const existing = await env.DB.prepare('SELECT id FROM members WHERE email = ?').bind(email).first();
  if (existing) return json({ error: '?대? ?깅줉???대찓?쇱엯?덈떎' }, 409);

  // 以묐났 ?붿껌 ?뺤씤
  const pending = await env.DB.prepare(
    "SELECT id FROM signup_requests WHERE email = ? AND status = 'pending'"
  ).bind(email).first();
  if (pending) return json({ error: '?대? ?뱀씤 ?湲?以묒씤 ?붿껌???덉뒿?덈떎' }, 409);

  // signup_requests ?뚯씠釉??앹꽦
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      position TEXT NOT NULL,
      team TEXT DEFAULT 'all',
      message TEXT,
      status TEXT DEFAULT 'pending',
      reviewer_comment TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  await env.DB.prepare(
    'INSERT INTO signup_requests (name, email, position, team, message) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, email, position, team || 'all', message || null).run();

  // admin ?대찓???뚮┝ (MailChannels via CF Workers ??臾대즺)
  try {
    await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: 'studiojun4347@gmail.com', name: 'JUN' }] }],
        from: { email: 'noreply@studiojun.co.kr', name: 'STUDIOJUN System' },
        subject: `[STUDIOJUN] 媛???뱀씤 ?붿껌 ??${name} (${position})`,
        content: [{
          type: 'text/html',
          value: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
            <h2 style="color:#6366f1">??媛???뱀씤 ?붿껌</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px;color:#666;width:80px">?대쫫</td><td style="padding:8px;font-weight:bold">${name}</td></tr>
              <tr><td style="padding:8px;color:#666">?대찓??/td><td style="padding:8px">${email}</td></tr>
              <tr><td style="padding:8px;color:#666">?ъ???/td><td style="padding:8px">${position}</td></tr>
              <tr><td style="padding:8px;color:#666">?</td><td style="padding:8px">${team || 'all'}</td></tr>
              ${message ? `<tr><td style="padding:8px;color:#666">硫붿떆吏</td><td style="padding:8px">${message}</td></tr>` : ''}
            </table>
            <div style="margin-top:20px">
              <a href="https://studiojun.co.kr" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none">??쒕낫?쒖뿉???뱀씤?섍린</a>
            </div>
          </div>`
        }]
      })
    });
  } catch(e) { /* ?대찓???ㅽ뙣?대룄 ?붿껌? ??λ맖 */ }

  return json({ success: true, message: '媛???붿껌???꾩넚?섏뿀?듬땲?? 愿由ъ옄 ?뱀씤 ???댁슜 媛?ν빀?덈떎.' }, 201);
}

// ===== 媛???뱀씤/諛섎젮 泥섎━ (admin ?꾩슜) =====
async function handleSignupRequests(path, req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if (user.role !== 'admin' && user.role !== 'pd') return json({ error: 'Forbidden' }, 403);

  const method = req.method;

  // GET /api/signup-requests ??紐⑸줉
  if (path === '/api/signup-requests' && method === 'GET') {
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || 'pending';
    const rows = await env.DB.prepare(
      'SELECT * FROM signup_requests WHERE status = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(status).all();
    return json({ success: true, requests: rows.results || [] });
  }

  // PUT /api/signup-requests/:id ???뱀씤 ?먮뒗 諛섎젮
  const idMatch = path.match(/^\/api\/signup-requests\/(\d+)$/);
  if (idMatch && method === 'PUT') {
    const id = idMatch[1];
    const { action, comment, role_override, team_override } = await req.json();
    if (!['approve', 'reject'].includes(action)) return json({ error: 'action: approve or reject' }, 400);

    const row = await env.DB.prepare('SELECT * FROM signup_requests WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404);
    if (row.status !== 'pending') return json({ error: '?대? 泥섎━???붿껌?낅땲?' }, 400);

    if (action === 'approve') {
      // 硫ㅻ쾭 ?먮룞 ?앹꽦 (?꾩떆 鍮꾨?踰덊샇)
      const tempPw = 'SJ' + Math.random().toString(36).slice(2, 10);
      const memberId = 'MEM_' + Date.now().toString(36);
      const hash = await hashPassword(tempPw);
      const role = role_override || mapPositionToRole(row.position);
      const team = team_override || row.team || 'all';

      await env.DB.prepare(
        'INSERT INTO members (id, name, email, password_hash, role, team, initials) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(memberId, row.name, row.email, hash, role, team, row.name.substring(0, 2)).run();

      // ?뱀씤 ?곹깭 ?낅뜲?댄듃
      await env.DB.prepare(
        "UPDATE signup_requests SET status='approved', reviewer_comment=?, reviewed_at=datetime('now') WHERE id=?"
      ).bind(comment || null, id).run();

      // ?뱀씤 ?대찓??諛쒖넚 (?꾩떆 鍮꾨?踰덊샇 ?ы븿)
      try {
        await fetch('https://api.mailchannels.net/tx/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: row.email, name: row.name }] }],
            from: { email: 'noreply@studiojun.co.kr', name: 'STUDIOJUN' },
            subject: '[STUDIOJUN] 媛?낆씠 ?뱀씤?섏뿀?듬땲',
            content: [{
              type: 'text/html',
              value: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
                <h2 style="color:#22c55e">媛???뱀씤 ?꾨즺</h2>
                <p>${row.name}?? STUDIOJUN 媛?낆씠 ?뱀씤?섏뿀?듬땲??</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="padding:8px;color:#666">?대찓??/td><td style="padding:8px;font-weight:bold">${row.email}</td></tr>
                  <tr><td style="padding:8px;color:#666">?꾩떆 鍮꾨?踰덊샇</td><td style="padding:8px;font-weight:bold;color:#ef4444">${tempPw}</td></tr>
                  <tr><td style="padding:8px;color:#666">??븷</td><td style="padding:8px">${role}</td></tr>
                </table>
                <p style="color:#666;margin-top:16px">泥?濡쒓렇????鍮꾨?踰덊샇瑜?蹂寃쏀빐二쇱꽭??</p>
                <a href="https://studiojun.co.kr" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;margin-top:12px">濡쒓렇?명븯湲?/a>
              </div>`
            }]
          })
        });
      } catch(e) { /* ?대찓???ㅽ뙣?대룄 怨꾩젙? ?앹꽦??*/ }

      return json({ success: true, status: 'approved', member_id: memberId, temp_password: tempPw });
    } else {
      // 諛섎젮
      await env.DB.prepare(
        "UPDATE signup_requests SET status='rejected', reviewer_comment=?, reviewed_at=datetime('now') WHERE id=?"
      ).bind(comment || null, id).run();

      // 諛섎젮 ?대찓??
      try {
        await fetch('https://api.mailchannels.net/tx/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: row.email, name: row.name }] }],
            from: { email: 'noreply@studiojun.co.kr', name: 'STUDIOJUN' },
            subject: '[STUDIOJUN] 媛???붿껌 寃곌낵',
            content: [{
              type: 'text/plain',
              value: `${row.name}?? 媛???붿껌??諛섎젮?섏뿀?듬땲??\n${comment ? '?ъ쑀: ' + comment : '?먯꽭???ы빆? 愿由ъ옄?먭쾶 臾몄쓽?댁＜?몄슂.'}`
            }]
          })
        });
      } catch(e) {}

      return json({ success: true, status: 'rejected' });
    }
  }

  return json({ error: 'Not found' }, 404);
}

// ?ъ?????role 留ㅽ븨
function mapPositionToRole(position) {
  const p = (position || '').toLowerCase();
  if (p.includes('媛먮룆') || p.includes('director') || p.includes('pd')) return 'pd';
  if (p.includes('?붿옄') || p.includes('design')) return 'member';
  if (p.includes('?좊땲') || p.includes('anim')) return 'member';
  if (p.includes('紐⑤뜽') || p.includes('model')) return 'member';
  if (p.includes('?뚮뜑') || p.includes('comp') || p.includes('?⑹꽦')) return 'member';
  if (p.includes('fx') || p.includes('?댄럺') || p.includes('effect')) return 'member';
  if (p.includes('?몄＜') || p.includes('vendor')) return 'vendor';
  return 'member';
}

async function getMe(req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const member = await env.DB.prepare('SELECT id,name,email,role,team,initials,lang FROM members WHERE id = ?').bind(user.id).first();
  return json(member);
}

async function logout(req, env) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('Set-Cookie', 'sj_jwt=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// ===== Shots CRUD =====
async function getShots(req, env) {
  const url = new URL(req.url);
  const rawProject = url.searchParams.get('project') || 'default';
  const projectAlias = String(rawProject).trim().toLowerCase();
  const projectId = ['turbo one', 'turboone', 'tbo', 'tbo-s1', 'tbo_s1'].includes(projectAlias) ? 'tbo' : rawProject;
  const team = url.searchParams.get('team');
  const status = url.searchParams.get('status');
  const ep = url.searchParams.get('ep');
  const requestedLimit = Number(url.searchParams.get('limit') || 500);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1000));
  const requestedOffset = Number(url.searchParams.get('offset') || 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);

  let sql = 'SELECT * FROM shots WHERE project_id = ?';
  const params = [projectId];
  if (team && team !== 'all') { sql += ' AND team = ?'; params.push(team); }
  if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  if (ep && ep !== 'all') { sql += " AND scene LIKE ?"; params.push(ep + '%'); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  const shotIds = results.map((shot) => shot.id);
  const commentCounts = new Map();
  if (shotIds.length) {
    // D1 variable limits can be lower than SQLite defaults on some prepared statements.
    // Keep this batch deliberately small so large shot pages never fail comment counts.
    const BATCH = 90;
    for (let i = 0; i < shotIds.length; i += BATCH) {
      const batch = shotIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const { results: counts } = await env.DB.prepare(
        `SELECT shot_id, COUNT(*) as count FROM comments WHERE shot_id IN (${placeholders}) GROUP BY shot_id`
      ).bind(...batch).all();
      for (const row of counts || []) commentCounts.set(row.shot_id, row.count);
    }
  }
  for (const shot of results) shot.comment_count = commentCounts.get(shot.id) || 0;
  return json(results);
}

async function getShot(id, env) {
  const shot = await env.DB.prepare('SELECT * FROM shots WHERE id = ?').bind(id).first();
  if (!shot) return json({ error: 'Shot not found' }, 404);
  const { results: comments } = await env.DB.prepare('SELECT * FROM comments WHERE shot_id = ? ORDER BY created_at DESC').bind(id).all();
  shot.comments = comments;
  const { results: files } = await env.DB.prepare('SELECT * FROM files WHERE shot_id = ?').bind(id).all();
  shot.files = files.map(f => ({ ...f, url: `/r2/download/${f.r2_key}` }));
  return json(shot);
}

async function createShot(req, env) {
  const data = await req.json();
  const id = data.id || ('SHOT_' + Date.now().toString(36));
  await env.DB.prepare(
    'INSERT INTO shots (id, project_id, scene, team, status, priority, assignee, start_date, due, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, data.project_id || 'default', data.scene || '', data.team || '', data.status || 'pending', data.priority || 'mid', data.assignee || '', data.start_date || '', data.due || '', data.note || '').run();
  await logActivity(env, data.project_id || 'default', data.assignee || '', 'shot_created', 'shot', id, `${id} ?앹꽦?`);
  return json({ id, ...data }, 201);
}

async function updateShot(id, req, env) {
  const data = await req.json();
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (['scene','team','status','priority','assignee','start_date','due','note'].includes(k)) {
      fields.push(`${k} = ?`); vals.push(v);
    }
  }
  if (!fields.length) return json({ error: 'No fields to update' }, 400);
  fields.push('updated_at = ?'); vals.push(Date.now()); vals.push(id);
  await env.DB.prepare(`UPDATE shots SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();

  const projectId = data.project_id || 'default';
  if (data.status) {
    await logActivity(env, projectId, null, 'status_changed', 'shot', id, `${id} ??${data.status}`);
    // Slack ?먮룞 ?뚮┝: ???곹깭 蹂寃?
    sendSlackEvent(env, {
      project_id: projectId,
      event_type: 'production_update',
      title: `???곹깭 蹂寃? ${id}`,
      body: `${id} ??${data.status}${data.team ? ` (${data.team})` : ''}${data.assignee ? ` ?대떦: ${data.assignee}` : ''}`,
    }).catch(() => {});
    // 而ㅻ㎤?쒖꽱??遊??뚮┝
    notifyCommandCenter(env, `?렗 *???곹깭 蹂寃? | \`${id}\` ??*${data.status}*${data.team ? ` | ${data.team}` : ''}${data.assignee ? ` | ?대떦: ${data.assignee}` : ''}`).catch(() => {});
  }

  // Pipeline cascade: when shot status ??'done', auto-create next department's work
  if (data.status === 'done') {
    const shot = await env.DB.prepare('SELECT * FROM shots WHERE id = ?').bind(id).first();
    if (shot) {
      const cascadeResult = await pipelineCascade(env, shot, projectId);
      return json({ id, ...data, pipeline: cascadeResult });
    }
  }

  return json({ id, ...data });
}

// ===== Pipeline Cascade System =====
// When a department completes a shot (status ??done), automatically create work for the next department
const PIPELINE_ORDER = ['design', 'modeling', 'rigging', 'animation', 'render', 'fx'];
const PIPELINE_TASKS = {
  design: {
    next: 'modeling',
    todoTitle: (scene) => `[紐⑤뜽留? ${scene} ???붿옄???꾨즺, 紐⑤뜽留??쒖옉`,
    shotStatus: 'pending'
  },
  modeling: {
    next: 'rigging',
    todoTitle: (scene) => `[由ш퉭] ${scene} ??紐⑤뜽留??꾨즺, 由ш퉭 ?쒖옉`,
    shotStatus: 'pending'
  },
  rigging: {
    next: 'animation',
    todoTitle: (scene) => `[?좊땲硫붿씠?? ${scene} ??由ш퉭 ?꾨즺, ?먯뀑 ?ㅼ슫濡쒕뱶 ???좊땲硫붿씠???쒖옉`,
    shotStatus: 'pending'
  },
  animation: {
    next: 'render',
    todoTitle: (scene) => `[?뚮뜑] ${scene} ???좊땲硫붿씠???꾨즺(Playblast), AI ?뚮뜑 ?湲`,
    shotStatus: 'confirm'  // render team reviews before rendering
  },
  render: {
    next: 'fx',
    todoTitle: (scene) => `[FX] ${scene} ???뚮뜑 ?꾨즺, ?댄럺???⑹꽦 ?쒖옉`,
    shotStatus: 'pending'
  }
  // fx is the final stage ??no cascade after
};

async function pipelineCascade(env, shot, projectId) {
  const currentTeam = (shot.team || '').toLowerCase();
  const config = PIPELINE_TASKS[currentTeam];
  if (!config) return { cascaded: false, reason: 'no_next_stage' };

  const nextTeam = config.next;
  const scene = shot.scene || shot.id;

  // Check if next-stage todo already exists for this shot (avoid duplicates)
  const existing = await env.DB.prepare(
    "SELECT id FROM todos WHERE shot_id = ? AND team = ? AND status != 'done'"
  ).bind(shot.id, nextTeam).first();
  if (existing) return { cascaded: false, reason: 'already_exists', existingTodoId: existing.id };

  // 1. Create todo for next department
  const todoId = 'TODO_' + Date.now().toString(36);
  await env.DB.prepare(
    'INSERT INTO todos (id, project_id, title, team, priority, assignee, due, shot_id, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    todoId, projectId, config.todoTitle(scene), nextTeam,
    shot.priority || 'mid', '', shot.due || '',
    shot.id, `?먮룞 ?앹꽦: ${currentTeam} ?꾨즺 ??${nextTeam} ?뚯씠?꾨씪`, 'todo'
  ).run();

  // 2. Create or update shot for next department
  // Check if a next-team shot already exists for this scene
  const existingShot = await env.DB.prepare(
    'SELECT id FROM shots WHERE scene = ? AND team = ? AND project_id = ?'
  ).bind(scene, nextTeam, projectId).first();

  let nextShotId;
  if (existingShot) {
    // Update existing shot status
    nextShotId = existingShot.id;
    await env.DB.prepare(
      'UPDATE shots SET status = ?, updated_at = ?, note = ? WHERE id = ?'
    ).bind(config.shotStatus, Date.now(), `${currentTeam} ?꾨즺 ???묒뾽 媛?`, nextShotId).run();
  } else {
    // Create new shot for next department
    nextShotId = `${scene}_${nextTeam}`.replace(/\s+/g, '_');
    await env.DB.prepare(
      'INSERT INTO shots (id, project_id, scene, team, status, priority, assignee, start_date, due, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      nextShotId, projectId, scene, nextTeam, config.shotStatus,
      shot.priority || 'mid', '', '', shot.due || '',
      `?뚯씠?꾨씪?? ${currentTeam} ??${nextTeam} ?먮룞 ?앹꽦`
    ).run();
  }

  // 3. Log the cascade
  await logActivity(env, projectId, 'pipeline', 'cascade', 'shot', shot.id,
    `${currentTeam} ?꾨즺 ??${nextTeam} ?먮룞 ?앹꽦 (todo: ${todoId}, shot: ${nextShotId})`);

  // Slack ?먮룞 ?뚮┝: ?뚯씠?꾨씪??罹먯뒪耳?대뱶
  sendSlackEvent(env, {
    project_id: projectId,
    event_type: 'production_update',
    title: `?뚯씠?꾨씪??罹먯뒪耳?대뱶: ${currentTeam} ??${nextTeam}`,
    body: `${scene} ?꾨즺 ??${nextTeam} ?먮룞 ?앹꽦\nTodo: ${todoId} | Shot: ${nextShotId}`,
  }).catch(() => {});

  return {
    cascaded: true,
    from: currentTeam,
    to: nextTeam,
    todoId,
    nextShotId,
    nextShotStatus: config.shotStatus
  };
}

async function deleteShot(id, req, env) {
  await env.DB.prepare('DELETE FROM comments WHERE shot_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM shots WHERE id = ?').bind(id).run();
  return json({ deleted: id });
}

// ===== Pipeline API =====
async function getPipelineStatus(req, env) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';

  const stages = {};
  for (const team of PIPELINE_ORDER) {
    const { results: shots } = await env.DB.prepare(
      'SELECT id, scene, status, assignee, updated_at FROM shots WHERE project_id = ? AND team = ? ORDER BY scene'
    ).bind(projectId, team).all();

    const counts = { total: shots.length, pending: 0, production: 0, confirm: 0, done: 0, hold: 0 };
    shots.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });

    stages[team] = { counts, shots: shots.slice(0, 100) };
  }

  // Recent cascade events
  const { results: cascadeLog } = await env.DB.prepare(
    "SELECT * FROM activity_log WHERE project_id = ? AND action = 'cascade' ORDER BY created_at DESC LIMIT 20"
  ).bind(projectId).all();

  return json({ pipeline: PIPELINE_ORDER, stages, recentCascades: cascadeLog });
}

// ===== Assets CRUD =====
async function getAssets(req, env) {
  const url = new URL(req.url);
  const rawProject = url.searchParams.get('project') || 'default';
  const projectAlias = String(rawProject).trim().toLowerCase();
  const projectId = ['turbo one', 'turboone', 'tbo', 'tbo-s1', 'tbo_s1'].includes(projectAlias) ? 'tbo' : rawProject;
  const requestedLimit = Number(url.searchParams.get('limit') || 1000);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 1000, 2000));
  const requestedOffset = Number(url.searchParams.get('offset') || 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  const { results } = await env.DB.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(projectId, limit, offset).all();
  return json(results);
}

async function createAsset(req, env) {
  const data = await req.json();
  const id = data.id || ('ASSET_' + Date.now().toString(36));
  await env.DB.prepare(
    'INSERT INTO assets (id, project_id, name, type, emoji, version, status, team, assignee, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, data.project_id || 'default', data.name || '', data.type || '', data.emoji || '?벀', data.version || 'v01', data.status || 'pending', data.team || '', data.assignee || '', data.note || '').run();
  return json({ id, ...data }, 201);
}

async function updateAsset(id, req, env) {
  const data = await req.json();
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (['name','type','emoji','version','status','team','assignee','note'].includes(k)) {
      fields.push(`${k} = ?`); vals.push(v);
    }
  }
  fields.push('updated_at = ?'); vals.push(Date.now()); vals.push(id);
  await env.DB.prepare(`UPDATE assets SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json({ id, ...data });
}

async function deleteAsset(id, req, env) {
  await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
  return json({ deleted: id });
}

// ===== Todos CRUD =====
async function getTodos(req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';
  const team = url.searchParams.get('team');
  let sql = 'SELECT * FROM todos WHERE project_id = ?';
  const params = [projectId];
  if (team && team !== 'all') { sql += ' AND team = ?'; params.push(team); }
  sql += ' ORDER BY created_at DESC';
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json(results);
}

async function createTodo(req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const data = await req.json();
  const id = data.id || 'TODO_' + Date.now().toString(36);
  await env.DB.prepare(
    'INSERT INTO todos (id, project_id, title, team, priority, assignee, due, shot_id, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, data.project_id || 'default', data.title || '', data.team || '', data.priority || 'mid', data.assignee || '', data.due || '', data.shot_id || data.shot || '', data.note || '', data.status || 'todo').run();

  // Slack ?먮룞 ?뚮┝: ???좎씪 ?앹꽦
  if (data.title) {
    sendSlackEvent(env, {
      project_id: data.project_id || 'default',
      event_type: 'production_update',
      title: `???좎씪: ${data.title}`,
      body: `?: ${data.team || '-'} | ?대떦: ${data.assignee || '-'} | ?곗꽑?쒖쐞: ${data.priority || 'mid'}${data.shot_id ? ` | Shot: ${data.shot_id}` : ''}`,
    }).catch(() => {});
  }

  return json({ ...data, id }, 201);
}

async function updateTodo(id, req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const data = await req.json();
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (['title','team','priority','assignee','due','shot_id','note','status'].includes(k)) {
      fields.push(`${k} = ?`); vals.push(v);
    }
  }
  fields.push('updated_at = ?'); vals.push(Date.now()); vals.push(id);
  await env.DB.prepare(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();

  // Slack ?먮룞 ?뚮┝: ?좎씪 ?곹깭 蹂寃?
  if (data.status) {
    sendSlackEvent(env, {
      project_id: data.project_id || 'default',
      event_type: 'production_update',
      title: `?좎씪 ${data.status === 'done' ? '?꾨즺' : '蹂寃'}: ${id}`,
      body: `${data.title || id} ??${data.status}${data.team ? ` (${data.team})` : ''}`,
    }).catch(() => {});
    const emoji = data.status === 'done' ? '\u2705' : data.status === 'in_progress' ? '\u23f3' : '\u26a0\ufe0f';
    notifyCommandCenter(env, `${emoji} *?좎씪 ${data.status === 'done' ? '?꾨즺' : '?곹깭蹂寃'}* | \`${data.title || id}\` ??*${data.status}*${data.team ? ` | ${data.team}` : ''}`).catch(() => {});
  }

  return json({ id, ...data });
}

async function deleteTodo(id, req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  await env.DB.prepare('DELETE FROM todos WHERE id = ?').bind(id).run();
  return json({ deleted: id });
}

// ===== Comments =====
async function getComments(req, env) {
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(req.url);
  const shotId = url.searchParams.get('shot_id');
  if (!shotId) return json({ error: 'shot_id required' }, 400);
  const { results } = await env.DB.prepare('SELECT * FROM comments WHERE shot_id = ? ORDER BY created_at ASC').bind(shotId).all();
  return json(results);
}

async function createComment(req, env) {
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const data = await req.json();
  if (!data.shot_id || !data.text) return json({ error: 'shot_id and text required' }, 400);
  await env.DB.prepare(
    'INSERT INTO comments (shot_id, author_id, author_name, text, role) VALUES (?, ?, ?, ?, ?)'
  ).bind(data.shot_id, user.id, user.name || user.id, data.text, user.role || 'member').run();
  return json({ success: true }, 201);
}

// ===== Messages =====
async function getMessages(req, env) {
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';
  const room = url.searchParams.get('room') || 'general';
  const { results } = await env.DB.prepare(
    'SELECT * FROM messages WHERE project_id = ? AND room = ? ORDER BY created_at DESC LIMIT 100'
  ).bind(projectId, room).all();
  return json(results.reverse());
}

async function createMessage(req, env) {
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const data = await req.json();
  await env.DB.prepare(
    'INSERT INTO messages (project_id, room, sender_id, sender_name, text, lang, shot_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(data.project_id || 'default', data.room || 'general', user.id, user.name || user.id, data.text, data.lang || 'ko', data.shot_id).run();
  return json({ success: true }, 201);
}

// ===== Projects =====
async function getProjects(env) {
  const { results } = await env.DB.prepare(
    "SELECT p.*, (SELECT COUNT(*) FROM shots WHERE project_id = p.id) as total_shots, (SELECT COUNT(*) FROM shots WHERE project_id = p.id AND status = 'done') as done_shots, (SELECT COUNT(*) FROM todos WHERE project_id = p.id AND status != 'done') as open_todos FROM projects p WHERE p.status != 'archived' ORDER BY p.created_at DESC"
  ).all();
  return json(results.map(p => ({
    ...p,
    progress: p.total_shots > 0 ? Math.round((p.done_shots / p.total_shots) * 100) : 0
  })));
}

async function getProject(id, env) {
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
  if (!project) return json({ error: 'Project not found' }, 404);
  // ?蹂?吏꾪뻾瑜?怨꾩궛
  const { results: teamStats } = await env.DB.prepare(
    "SELECT team, COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done FROM shots WHERE project_id = ? GROUP BY team"
  ).bind(id).all();
  const { results: recentActivity } = await env.DB.prepare(
    'SELECT * FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 20'
  ).bind(id).all();
  const totalShots = teamStats.reduce((s, t) => s + t.total, 0);
  const doneShots = teamStats.reduce((s, t) => s + t.done, 0);
  return json({
    ...project,
    total_shots: totalShots,
    done_shots: doneShots,
    progress: totalShots > 0 ? Math.round((doneShots / totalShots) * 100) : 0,
    team_stats: teamStats,
    recent_activity: recentActivity
  });
}

// ===== TBO Dashboard Summary =====
async function getTBODashboard(env) {
  const pid = 'prj_tbo_s1';

  // ?먰뵾?뚮뱶蹂????꾪솴
  const { results: epStats } = await env.DB.prepare(`
    SELECT substr(shot_code, 4, 5) as ep,
      COUNT(*) as total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status='in_progress' OR status='wip' THEN 1 ELSE 0 END) as wip,
      SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) as review,
      SUM(CASE WHEN postprod_png != '' AND postprod_png IS NOT NULL THEN 1 ELSE 0 END) as pp_png,
      SUM(CASE WHEN postprod_mov != '' AND postprod_mov IS NOT NULL THEN 1 ELSE 0 END) as pp_mov,
      SUM(CASE WHEN postprod_fx != '' AND postprod_fx IS NOT NULL THEN 1 ELSE 0 END) as pp_fx
    FROM shots WHERE project_id=? AND shot_code LIKE 'TB_EP%'
    GROUP BY ep ORDER BY ep
  `).bind(pid).all();

  // ?먯뀑 ?뚯씠?꾨씪??
  const { results: assetStats } = await env.DB.prepare(`
    SELECT category as asset_type, COUNT(*) as total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status='in_progress' OR status='wip' THEN 1 ELSE 0 END) as wip
    FROM assets WHERE project_id=? GROUP BY category
  `).bind(pid).all();

  // ?꾩껜 ?붿빟
  const totals = epStats.reduce((a, e) => ({
    shots: a.shots + e.total,
    done: a.done + e.done,
    wip: a.wip + e.wip,
    review: a.review + e.review,
    pp_png: a.pp_png + e.pp_png,
    pp_mov: a.pp_mov + e.pp_mov,
    pp_fx: a.pp_fx + e.pp_fx
  }), { shots: 0, done: 0, wip: 0, review: 0, pp_png: 0, pp_mov: 0, pp_fx: 0 });

  return json({
    project: 'TurboOne Season 1',
    episodes: epStats,
    assets: assetStats,
    summary: {
      total_episodes: epStats.length,
      total_shots: totals.shots,
      ani_done: totals.done,
      ani_wip: totals.wip,
      ani_review: totals.review,
      ani_progress: totals.shots > 0 ? Math.round((totals.done / totals.shots) * 100) : 0,
      postprod_png: totals.pp_png,
      postprod_mov: totals.pp_mov,
      postprod_fx: totals.pp_fx
    }
  });
}

async function getProjectStats(id, env) {
  const { results: teamStats } = await env.DB.prepare(
    "SELECT team, COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'wip' THEN 1 ELSE 0 END) as wip, SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review FROM shots WHERE project_id = ? GROUP BY team"
  ).bind(id).all();
  const { results: todoStats } = await env.DB.prepare(
    "SELECT status, COUNT(*) as cnt FROM todos WHERE project_id = ? GROUP BY status"
  ).bind(id).all();
  const { results: weeklyActivity } = await env.DB.prepare(
    "SELECT DATE(created_at/1000, 'unixepoch') as day, COUNT(*) as cnt FROM activity_log WHERE project_id = ? AND created_at > (unixepoch() - 604800) * 1000 GROUP BY day ORDER BY day"
  ).bind(id).all();
  return json({ team_stats: teamStats, todo_stats: todoStats, weekly_activity: weeklyActivity });
}

async function createProject(req, env) {
  const data = await req.json();
  const id = data.id || ('PROJ_' + Date.now().toString(36));
  const allowedFields = ['name','client','status','project_type','start_date','deadline','ep_start','ep_end','ep_count','episode_range','description','thumbnail_url','created_by'];
  const fields = ['id'], vals = [id], placeholders = ['?'];
  for (const [k, v] of Object.entries(data)) {
    if (allowedFields.includes(k) && v !== undefined) {
      fields.push(k); vals.push(v); placeholders.push('?');
    }
  }
  await env.DB.prepare(
    `INSERT INTO projects (${fields.join(',')}) VALUES (${placeholders.join(',')})`
  ).bind(...vals).run();
  return json({ id, ...data }, 201);
}

async function updateProject(id, req, env) {
  const data = await req.json();
  const allowedFields = ['name','client','status','project_type','start_date','deadline','ep_start','ep_end','ep_count','episode_range','description','thumbnail_url','team_progress','created_by'];
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (allowedFields.includes(k)) {
      fields.push(`${k} = ?`); vals.push(v);
    }
  }
  if (fields.length === 0) return json({ error: 'No valid fields' }, 400);
  fields.push('updated_at = ?'); vals.push(Date.now()); vals.push(id);
  await env.DB.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json({ id, ...data });
}

async function archiveProject(id, req, env) {
  if (id === 'default') return json({ error: 'Cannot delete default project' }, 400);
  await env.DB.prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return json({ id, status: 'archived' });
}

async function switchProject(id, req, env) {
  const project = await env.DB.prepare('SELECT id, name FROM projects WHERE id = ?').bind(id).first();
  if (!project) return json({ error: 'Project not found' }, 404);
  return json({ current_project: project });
}

// ===== Members =====
async function getMembers(req, env) {
  const user = await getRequestUser(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const { results } = await env.DB.prepare('SELECT id,name,email,role,team,initials,avatar_color,is_active FROM members ORDER BY name').all();
  if (canManageProduction(user)) return json(results);
  return json(results.map(member => ({
    id: member.id,
    name: member.name,
    role: member.role,
    team: member.team,
    initials: member.initials,
    avatar_color: member.avatar_color,
    is_active: member.is_active
  })));
}

async function createMember(req, env) {
  const data = await req.json();
  const id = 'MEM_' + Date.now().toString(36);
  const hash = data.password ? await hashPassword(data.password) : null;
  await env.DB.prepare(
    'INSERT INTO members (id, name, email, password_hash, role, team, initials) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, data.name || '', data.email || '', hash, data.role || 'member', data.team || 'all', data.initials || (data.name || '').substring(0, 2)).run();
  return json({ id, name: data.name, role: data.role }, 201);
}

async function updateMember(id, req, env) {
  const data = await req.json();
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (['name','role','team','initials','lang','is_active'].includes(k)) {
      fields.push(`${k} = ?`); vals.push(v);
    }
  }
  vals.push(id);
  await env.DB.prepare(`UPDATE members SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json({ id, ...data });
}

// ===== Stats =====
async function getStats(req, env) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';

  const total = await env.DB.prepare('SELECT COUNT(*) as c FROM shots WHERE project_id = ?').bind(projectId).first();
  const done = await env.DB.prepare("SELECT COUNT(*) as c FROM shots WHERE project_id = ? AND status = 'done'").bind(projectId).first();
  const review = await env.DB.prepare("SELECT COUNT(*) as c FROM shots WHERE project_id = ? AND status = 'confirm'").bind(projectId).first();
  const hold = await env.DB.prepare("SELECT COUNT(*) as c FROM shots WHERE project_id = ? AND status = 'hold'").bind(projectId).first();

  const { results: teamStats } = await env.DB.prepare(
    "SELECT team, status, COUNT(*) as count FROM shots WHERE project_id = ? GROUP BY team, status"
  ).bind(projectId).all();

  return json({ total: total.c, done: done.c, review: review.c, hold: hold.c, teamStats });
}

// ===== Activity =====
async function getActivity(req, env) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';
  const { results } = await env.DB.prepare(
    'SELECT * FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 20'
  ).bind(projectId).all();
  return json(results);
}

// ===== File Upload (legacy) =====
async function uploadFile(req, env) {
  const formData = await req.formData();
  const file = formData.get('file');
  if (!file) return json({ error: 'No file' }, 400);
  const projectId = formData.get('project_id') || 'default';
  const shotId = formData.get('shot_id');
  const key = `${projectId}/${Date.now()}_${file.name}`;
  await env.R2.put(key, file, { httpMetadata: { contentType: file.type } });
  await env.DB.prepare(
    'INSERT INTO files (project_id, shot_id, filename, r2_key, size, mime_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(projectId, shotId, file.name, key, file.size, file.type).run();
  return json({ key, filename: file.name, size: file.size }, 201);
}

async function downloadFile(id, env) {
  const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!file) return json({ error: 'File not found' }, 404);
  const object = await env.R2.get(file.r2_key);
  if (!object) return json({ error: 'File not in storage' }, 404);
  return new Response(object.body, {
    headers: { 'Content-Type': file.mime_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.filename}"` }
  });
}

// ===== Bulk State =====
async function loadState(req, env) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';

  const [shots, assets, todos, messages, members, projects, notifications, activity] = await Promise.all([
    env.DB.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY created_at DESC').bind(projectId).all(),
    env.DB.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC').bind(projectId).all(),
    env.DB.prepare('SELECT * FROM todos WHERE project_id = ? ORDER BY created_at DESC').bind(projectId).all(),
    env.DB.prepare("SELECT * FROM messages WHERE project_id = ? AND room = 'general' ORDER BY created_at DESC LIMIT 100").bind(projectId).all(),
    env.DB.prepare('SELECT id,name,email,role,team,initials,avatar_color,is_active FROM members ORDER BY name').all(),
    env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC').all(),
    env.DB.prepare('SELECT * FROM notifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 30').bind(projectId).all(),
    env.DB.prepare('SELECT * FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').bind(projectId).all()
  ]);

  // 諛곗튂 荑쇰━: 紐⑤뱺 ?룹쓽 ?볤?????踰덉뿉 議고쉶 (媛쒕퀎 荑쇰━ 3983????1??
  const shotIds = shots.results.map(s => s.id);
  const commentsMap = {};
  if (shotIds.length > 0) {
    const { results: allComments } = await env.DB.prepare(
      'SELECT * FROM comments WHERE shot_id IN (SELECT id FROM shots WHERE project_id = ?) ORDER BY created_at ASC'
    ).bind(projectId).all();
    for (const c of allComments) {
      if (!commentsMap[c.shot_id]) commentsMap[c.shot_id] = [];
      commentsMap[c.shot_id].push(c);
    }
  }
  for (const shot of shots.results) {
    shot.comments = commentsMap[shot.id] || [];
  }

  const rooms = ['general', 'animation', 'fx', 'hanoi'];
  const messagesByRoom = {};
  for (const room of rooms) {
    const { results: roomMsgs } = await env.DB.prepare(
      'SELECT * FROM messages WHERE project_id = ? AND room = ? ORDER BY created_at ASC LIMIT 100'
    ).bind(projectId, room).all();
    messagesByRoom[room] = roomMsgs.map(m => ({
      id: m.id, from: m.sender_name, text: m.text,
      time: new Date(m.created_at).toISOString().slice(0,16).replace('T',' '),
      lang: m.lang || 'ko', room: m.room, role: 'member', color: '#4f7cff', mine: false
    }));
  }

  const project = projects.results[0] || { name: '?곕낫??S01', episode_range: 'EP01-26', deadline: '2025-12-31' };

  return json({
    shots: shots.results.map(s => ({
      id: s.id, scene: s.scene, team: s.team, status: s.status || 'pending',
      priority: s.priority || 'mid', assignee: s.assignee || '', startDate: s.start_date || '',
      due: s.due || '', note: s.note || '',
      comments: (s.comments || []).map(c => ({
        author: c.author_name, text: c.text, role: c.role || 'member',
        time: new Date(c.created_at).toISOString().slice(0,16).replace('T',' ')
      })),
      createdAt: s.created_at
    })),
    assets: assets.results.map(a => ({
      id: a.id, name: a.name, type: a.type || 'character', emoji: a.emoji || '?벀',
      version: a.version || 'v01', status: a.status || 'pending',
      team: a.team || '', assignee: a.assignee || '', note: a.note || '', createdAt: a.created_at
    })),
    todos: todos.results.map(t => ({
      id: t.id, title: t.title, team: t.team || '', status: t.status || 'todo',
      priority: t.priority || 'mid', assignee: t.assignee || '', due: t.due || '',
      shot: t.shot_id || '', note: t.note || '', createdAt: t.created_at
    })),
    messages: messagesByRoom,
    members: members.results.map(m => ({
      id: m.id, name: m.name, email: m.email || '', role: m.role || 'member',
      team: m.team || 'all', initials: m.initials || m.name.substring(0,2), active: m.is_active === 1
    })),
    projects: projects.results,
    notifications: notifications.results.map(n => ({
      id: n.id, title: n.title, desc: n.description || '',
      time: new Date(n.created_at).toISOString().slice(0,16).replace('T',' '),
      read: n.is_read === 1, type: 'info'
    })),
    project: {
      id: project.id, name: project.name || '?곕낫??S01',
      meta: (project.episode_range || 'EP01-26') + ' 쨌 2025 Q3',
      deadline: project.deadline || '2025-12-31', epCount: project.ep_count || 26
    }
  });
}

async function saveState(req, env) {
  const data = await req.json();
  const projectId = data.projectId || 'default';

  if (data.shots) {
    await env.DB.prepare('DELETE FROM shots WHERE project_id = ?').bind(projectId).run();
    for (const s of data.shots) {
      await env.DB.prepare(
        'INSERT INTO shots (id, project_id, scene, team, status, priority, assignee, start_date, due, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(s.id, projectId, s.scene, s.team, s.status, s.priority, s.assignee, s.startDate, s.due, s.note, s.createdAt || Date.now()).run();
      if (s.comments?.length) {
        for (const c of s.comments) {
          await env.DB.prepare(
            'INSERT INTO comments (shot_id, author_name, text, role, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(s.id, c.author, c.text, c.role, new Date(c.time).getTime() || Date.now()).run();
        }
      }
    }
  }

  if (data.assets) {
    await env.DB.prepare('DELETE FROM assets WHERE project_id = ?').bind(projectId).run();
    for (const a of data.assets) {
      await env.DB.prepare(
        'INSERT INTO assets (id, project_id, name, type, emoji, version, status, team, assignee, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(a.id, projectId, a.name, a.type, a.emoji, a.version, a.status, a.team, a.assignee, a.note, a.createdAt || Date.now()).run();
    }
  }

  if (data.todos) {
    await env.DB.prepare('DELETE FROM todos WHERE project_id = ?').bind(projectId).run();
    for (const t of data.todos) {
      await env.DB.prepare(
        'INSERT INTO todos (id, project_id, title, team, priority, assignee, due, shot_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(t.id, projectId, t.title, t.team, t.priority, t.assignee, t.due, t.shot, t.note, t.status, t.createdAt || Date.now()).run();
    }
  }

  if (data.notifications) {
    await env.DB.prepare('DELETE FROM notifications WHERE project_id = ?').bind(projectId).run();
    for (const n of data.notifications) {
      await env.DB.prepare(
        'INSERT INTO notifications (project_id, title, description, is_read, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(projectId, n.title, n.desc, n.read ? 1 : 0, new Date(n.time).getTime() || Date.now()).run();
    }
  }

  if (data.messages) {
    for (const room of Object.keys(data.messages)) {
      await env.DB.prepare('DELETE FROM messages WHERE project_id = ? AND room = ?').bind(projectId, room).run();
      for (const m of data.messages[room]) {
        await env.DB.prepare(
          'INSERT INTO messages (project_id, room, sender_name, text, lang, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(projectId, room, m.from, m.text, m.lang, new Date(m.time).getTime() || Date.now()).run();
      }
    }
  }

  return json({ success: true });
}

// ===== Notifications =====
async function getNotifications(req, env) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project') || 'default';
  const { results } = await env.DB.prepare(
    'SELECT * FROM notifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 30'
  ).bind(projectId).all();
  return json(results);
}

async function createNotification(req, env) {
  const data = await req.json();
  await env.DB.prepare(
    'INSERT INTO notifications (project_id, target_id, title, description) VALUES (?, ?, ?, ?)'
  ).bind(data.project_id || 'default', data.target_id, data.title, data.description).run();
  return json({ success: true }, 201);
}

async function readAllNotifications(req, env) {
  const data = await req.json();
  await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE project_id = ?').bind(data.project_id || 'default').run();
  return json({ success: true });
}

// ===== Slack Bridge =====
const SLACK_CHANNEL_POLICY = [
  { key: 'announcements', name: '#sj-announcements', audience: 'all', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_ANNOUNCEMENTS', purpose: 'company-wide notices' },
  { key: 'production', name: '#tbo-production', audience: 'tbo_team', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_PRODUCTION', purpose: 'TURBO ONE production status' },
  { key: 'review', name: '#tbo-review', audience: 'director_ad_pd', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_REVIEW', purpose: 'shot review and frame feedback' },
  { key: 'assets', name: '#tbo-assets', audience: 'asset_design', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_ASSETS', purpose: 'design/modeling/rigging asset work' },
  { key: 'animation', name: '#tbo-animation', audience: 'abanu_animation', external: true, webhookEnv: 'SLACK_WEBHOOK_URL_ANIMATION', purpose: 'Abanu animation vendor communication' },
  { key: 'schedule', name: '#tbo-schedule', audience: 'production_management', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_SCHEDULE', purpose: 'Google Sheets schedule, gantt, delay alerts' },
  { key: 'ai_seedance', name: '#tbo-ai-seedance', audience: 'ai_pipeline', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_AI_SEEDANCE', purpose: 'Seedance and AI automation tests' },
  { key: 'client_aive', name: '#tbo-client-aive', audience: 'aive_client', external: true, webhookEnv: 'SLACK_WEBHOOK_URL_CLIENT_AIVE', purpose: 'AIVE/client-safe production updates' },
  { key: 'internal', name: '#sj-internal', audience: 'studiojun_internal', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_INTERNAL', purpose: 'StudioJUN internal operations' },
  { key: 'codex_claude_ops', name: '#sj-codex-claude-ops', audience: 'automation_ops', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_CODEX_CLAUDE_OPS', purpose: 'Codex and Claude work log, QA, blockers' },
  { key: 'deploy_alerts', name: '#sj-deploy-alerts', audience: 'automation_ops', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_DEPLOY_ALERTS', purpose: 'deploy and infra alerts' },
  { key: 'daily_report', name: '#sj-daily-report', audience: 'production_management', external: false, webhookEnv: 'SLACK_WEBHOOK_URL_DAILY_REPORT', purpose: '09:00 and 18:00 production digest' },
];

const SLACK_EVENT_ROUTES = {
  review_request: 'review',
  review_comment: 'review',
  review_playback_failed: 'deploy_alerts',
  r2_playback_failed: 'deploy_alerts',
  r2_sync_failed: 'deploy_alerts',
  r2_sync_complete: 'deploy_alerts',
  nas_r2_sync: 'deploy_alerts',
  sheets_write_failed: 'schedule',
  sheets_writeback_failed: 'schedule',
  sheets_writeback_complete: 'schedule',
  schedule_delay: 'schedule',
  daily_report: 'daily_report',
  weekly_report: 'daily_report',
  seedance_job: 'ai_seedance',
  seedance_failed: 'ai_seedance',
  invite_ready: 'announcements',
  external_invite_ready: 'announcements',
  codex_status: 'codex_claude_ops',
  claude_status: 'codex_claude_ops',
  qa_result: 'codex_claude_ops',
  deploy_complete: 'deploy_alerts',
  production_update: 'production',
};

const SLACK_HIGH_IMPACT_EVENTS = new Set([
  'review_playback_failed',
  'r2_playback_failed',
  'r2_sync_failed',
  'sheets_write_failed',
  'sheets_writeback_failed',
  'seedance_failed',
  'deploy_failed',
  'external_invite_ready',
]);

function canManageSlack(user) {
  const role = String(user?.role || '').toLowerCase();
  return ['admin', 'owner', 'pd', 'producer'].includes(role);
}

async function ensureSlackTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slack_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT DEFAULT 'tbo',
    event_type TEXT,
    title TEXT,
    body TEXT,
    channel_hint TEXT,
    status TEXT DEFAULT 'queued',
    response_text TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )`).run();
}

function getSlackChannelByKey(key) {
  return SLACK_CHANNEL_POLICY.find((channel) => channel.key === key) || null;
}

function getSlackRoute(eventType, channelHint) {
  const hint = String(channelHint || '').replace(/^#/, '').trim();
  if (hint) {
    const direct = SLACK_CHANNEL_POLICY.find((channel) => channel.key === hint || channel.name.replace(/^#/, '') === hint);
    if (direct) return direct;
  }
  return getSlackChannelByKey(SLACK_EVENT_ROUTES[eventType] || 'production') || getSlackChannelByKey('production');
}

function getSlackWebhookMap(env) {
  if (!env.SLACK_WEBHOOKS_JSON) return {};
  try {
    return JSON.parse(env.SLACK_WEBHOOKS_JSON);
  } catch {
    return {};
  }
}

function getSlackWebhookUrl(env, channel) {
  const webhookMap = getSlackWebhookMap(env);
  return env[channel?.webhookEnv] || webhookMap[channel?.key] || env.SLACK_WEBHOOK_URL || '';
}

function sanitizeSlackText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]{16,}/g, 'sk-[redacted]')
    .replace(/C:\\Users\\[^ \n\r\t]+/g, '[local-path-redacted]')
    .replace(/(SLACK_WEBHOOK_URL|CF_API_TOKEN|JWT_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_SERVICE_ACCOUNT_KEY)=\S+/g, '$1=[redacted]')
    .slice(0, 3000);
}

function slackPayload({ title, body, event_type, project_id, channel, linear_issue, evidence, next_owner }) {
  const label = event_type || 'production_update';
  const project = project_id || 'TURBO ONE';
  const routedChannel = getSlackRoute(label, channel);
  const safeTitle = sanitizeSlackText(title || 'STUDIOJUN production update').slice(0, 140);
  const safeBody = sanitizeSlackText(body || 'Production management event was recorded.');
  const fields = [
    { type: 'mrkdwn', text: `*Project*\n${sanitizeSlackText(project).slice(0, 80)}` },
    { type: 'mrkdwn', text: `*Type*\n${sanitizeSlackText(label).slice(0, 80)}` },
    { type: 'mrkdwn', text: `*Route*\n${routedChannel?.name || '#unknown'}` },
    { type: 'mrkdwn', text: `*Impact*\n${SLACK_HIGH_IMPACT_EVENTS.has(label) ? 'High' : 'Normal'}` },
  ];
  if (linear_issue) fields.push({ type: 'mrkdwn', text: `*Linear*\n${sanitizeSlackText(linear_issue).slice(0, 80)}` });
  if (next_owner) fields.push({ type: 'mrkdwn', text: `*Next owner*\n${sanitizeSlackText(next_owner).slice(0, 80)}` });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: safeTitle, emoji: true } },
    { type: 'section', fields },
    { type: 'section', text: { type: 'mrkdwn', text: safeBody } },
  ];
  if (evidence) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Evidence: \`${sanitizeSlackText(evidence).slice(0, 180)}\`` }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `STUDIOJUN Slack bridge | ${new Date().toISOString()} | Linear is source of truth` }] });

  return { text: `[${project}] ${safeTitle}`, blocks };
}

async function postSlackWebhook(env, payload, channel) {
  const webhookUrl = getSlackWebhookUrl(env, channel);
  if (!webhookUrl) {
    return { ok: false, status: 503, response_text: `${channel?.webhookEnv || 'SLACK_WEBHOOK_URL'} is not configured` };
  }
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  return { ok: response.ok, status: response.status, response_text: responseText };
}

// 而ㅻ㎤?쒖꽱?곗뿉 遊뉗쑝濡?CRUD ?뚮┝ ?꾩넚
async function notifyCommandCenter(env, text) {
  try {
    const token = await getSlackConfigValue(env, 'SLACK_BOT_TOKEN_GREEN');
    if (!token) return;
    await postSlackBotMessage(token, { channel: JUN_COMMAND_CENTER_ID, text, unfurl_links: false });
  } catch (e) { console.error('[SLACK] notifyCC err:', e.message); }
}

async function sendSlackEvent(env, message) {
  await ensureSlackTables(env);
  const channel = getSlackRoute(message.event_type || 'production_update', message.channel);
  const payload = slackPayload({ ...message, channel: channel.key });
  const result = await postSlackWebhook(env, payload, channel);
  await env.DB.prepare(
    'INSERT INTO slack_events (project_id, event_type, title, body, channel_hint, status, response_text) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    message.project_id || 'TURBO ONE',
    message.event_type || 'production_update',
    sanitizeSlackText(message.title || ''),
    sanitizeSlackText(message.body || message.message || ''),
    channel.key,
    result.ok ? 'sent' : 'failed',
    result.response_text
  ).run();
  return { success: result.ok, configured: Boolean(getSlackWebhookUrl(env, channel)), route: channel, status: result.status, response_text: result.response_text };
}

function slackConfig(env) {
  const webhookMap = getSlackWebhookMap(env);
  const channels = SLACK_CHANNEL_POLICY.map((channel) => ({
    ...channel,
    configured: Boolean(env[channel.webhookEnv] || webhookMap[channel.key] || env.SLACK_WEBHOOK_URL),
  }));
  return {
    success: true,
    configured: channels.some((channel) => channel.configured),
    mode: 'incoming_webhook',
    codex_claude_connector: 'Slack app connector is used for human-visible Codex/Claude ops posts.',
    linear_source_of_truth: true,
    channels,
    event_routes: SLACK_EVENT_ROUTES,
    immediate_events: Array.from(SLACK_HIGH_IMPACT_EVENTS),
    scheduled_reports: [
      { time: '09:00', channel: '#sj-daily-report', purpose: 'today plan and blockers' },
      { time: '18:00', channel: '#sj-daily-report', purpose: 'done, blockers, next actions' },
    ],
    safety: {
      slack_is_not_source_of_truth: true,
      final_status_in_linear: true,
      evidence_in_codex_sync: true,
      no_tokens_or_nas_paths_in_slack: true,
      external_channels_are_filtered: true,
    },
  };
}

async function handleSlackAPI(path, request, env) {
  const method = request.method;
  const user = await authenticateAny(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  await ensureSlackTables(env);

  if (path === '/api/slack/config' && method === 'GET') {
    return json(slackConfig(env));
  }

  if (path === '/api/slack/test' && method === 'POST') {
    if (!canManageSlack(user)) return json({ error: 'Admin/PD only' }, 403);
    const body = await request.json().catch(() => ({}));
    const result = await sendSlackEvent(env, {
      project_id: body.project_id || 'TURBO ONE',
      event_type: body.event_type || 'test',
      title: body.title || 'STUDIOJUN Slack bridge test',
      body: body.body || 'Slack incoming webhook smoke test.',
      channel: body.channel || 'deploy_alerts',
      linear_issue: body.linear_issue || '',
      evidence: body.evidence || 'codex-sync/slack-ops-latest.md',
      next_owner: body.next_owner || 'Codex/Claude',
    });
    return json(result, result.success ? 200 : result.status);
  }

  if (path === '/api/slack/notify' && method === 'POST') {
    if (!canManageSlack(user)) return json({ error: 'Admin/PD only' }, 403);
    const body = await request.json().catch(() => ({}));
    if (!(body.body || body.message)) return json({ error: 'body or message required' }, 400);
    const result = await sendSlackEvent(env, {
      project_id: body.project_id || 'TURBO ONE',
      event_type: body.event_type || 'production_update',
      title: body.title || 'STUDIOJUN production update',
      body: body.body || body.message || '',
      channel: body.channel || '',
      linear_issue: body.linear_issue || '',
      evidence: body.evidence || '',
      next_owner: body.next_owner || '',
    });
    return json(result, result.success ? 200 : result.status);
  }

  if (path === '/api/slack/events' && method === 'GET') {
    if (!canManageSlack(user)) return json({ error: 'Admin/PD only' }, 403);
    const { results } = await env.DB.prepare('SELECT * FROM slack_events ORDER BY created_at DESC LIMIT 50').all();
    return json({ success: true, events: results || [] });
  }

  return json({ error: 'Slack API endpoint not found: ' + path }, 404);
}

// ===== Slack Events API Webhook Handler =====
// POST /api/slack/webhook ??Handles Slack Events API (no JWT, verified by signing secret)
const JUN_COMMAND_CENTER_ID = 'C0B471SGV8D';
const SLACK_AGENTS = {
  GREEN: {
    name: 'Dispatch', tokenKey: 'SLACK_CLAUDE_TOKEN', role: 'Producer/QA/?꾨줎?몄뿏??珥앷큵', emoji: ':large_green_circle:',
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKeyEnv: 'ANTHROPIC_API_KEY', maxTokens: 4096 },
  },
  RED: {
    name: 'Codex', tokenKey: 'SLACK_CODEX_TOKEN', role: 'Backend/Deploy/Code', emoji: ':red_circle:',
    llm: { provider: 'openai', model: 'o3', apiKeyEnv: 'OPENAI_API_KEY', maxTokens: 4096 },
  },
  BLUE: {
    name: 'Gemini', tokenKey: 'SLACK_GEMINI_TOKEN', role: 'Google?앺깭怨??곗씠?곗젙??踰덉뿭', emoji: ':large_blue_circle:',
    llm: { provider: 'google', model: 'gemini-2.5-pro', apiKeyEnv: 'GOOGLE_AI_API_KEY', maxTokens: 4096 },
  },
};

function routeToAgent(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('@dispatch') || lower.includes('@green') || lower.includes('?붿뒪?⑥튂')) return 'GREEN';
  if (lower.includes('@codex') || lower.includes('@red') || lower.includes('肄붾뜳')) return 'RED';
  if (lower.includes('@gemini') || lower.includes('@blue') || lower.includes('?쒕?')) return 'BLUE';
  if (lower.includes('諛고룷') || lower.includes('deploy') || lower.includes('worker') || lower.includes('鍮뚮뱶') || lower.includes('linear') || lower.includes('肄붾뱶') || lower.includes('pr')) return 'RED';
  if (lower.includes('?쒗듃') || lower.includes('sheet') || lower.includes('踰덉뿭') || lower.includes('translate') || lower.includes('援ш?') || lower.includes('?숆린') || lower.includes('sync')) return 'BLUE';
  return 'GREEN';
}

async function getSlackConfigValue(env, key) {
  if (env[key]) return env[key];
  try {
    const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?').bind(key).first();
    return row?.value || null;
  } catch { return null; }
}

async function verifySlackSignature(request, env) {
  const signingSecret = await getSlackConfigValue(env, 'SLACK_SIGNING_SECRET');
  if (!signingSecret) return { valid: false, reason: 'SLACK_SIGNING_SECRET not configured', body: '' };
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) return { valid: false, reason: 'Missing slack headers', body: '' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return { valid: false, reason: 'Timestamp too old', body: '' };
  const body = await request.text();
  const sigBasestring = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBasestring));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  const computed = `v0=${hex}`;
  if (computed.length !== signature.length) return { valid: false, reason: 'Signature mismatch', body };
  let match = true;
  for (let i = 0; i < computed.length; i++) { if (computed[i] !== signature[i]) match = false; }
  return { valid: match, reason: match ? 'ok' : 'Signature mismatch', body };
}

async function handleSlackWebhook(request, env, ctx) {
  const verification = await verifySlackSignature(request, env);
  let payload;
  try { payload = JSON.parse(verification.body); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // URL Verification challenge (no signature check needed for setup)
  if (payload.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: payload.challenge }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Verify signature for all event callbacks
  if (!verification.valid) {
    console.error(`[SLACK-WEBHOOK] Signature failed: ${verification.reason}`);
    return json({ error: 'Invalid signature' }, 401);
  }

  if (payload.type === 'event_callback') {
    const event = payload.event;

    // 1. 而ㅻ㎤?쒖꽱??硫붿떆吏 ??3-agent ?쇱슦??
    if (event?.type === 'message' && event.channel === JUN_COMMAND_CENTER_ID) {
      if (event.bot_id || event.subtype === 'bot_message') return json({ ok: true, skipped: 'bot_message' });
      if (event.subtype && event.subtype !== 'file_share') return json({ ok: true, skipped: event.subtype });
      ctx.waitUntil(processCommandCenterMessage(env, event, payload.event_id).catch(e => console.error('[SLACK-WEBHOOK] Process error:', e.message)));
      return json({ ok: true, event_id: payload.event_id });
    }

    // 2. ?ㅻⅨ 梨꾨꼸 硫붿떆吏 ??D1 濡쒓퉭 + 遊?硫섏뀡 ?묐떟
    if (event?.type === 'message') {
      if (event.bot_id || event.subtype === 'bot_message') return json({ ok: true, skipped: 'bot_message' });
      if (event.text && /@(dispatch|codex|gemini|green|red|blue)/i.test(event.text)) {
        ctx.waitUntil(processChannelMention(env, event, payload.event_id).catch(e => console.error('[SLACK-WEBHOOK] Mention error:', e.message)));
      }
      return json({ ok: true, event_id: payload.event_id, channel: event.channel });
    }

    // 3. reaction_added ??由щ럭 ?뱀씤/由ъ젥 ?먮룞 泥섎━
    if (event?.type === 'reaction_added') {
      ctx.waitUntil(processReactionEvent(env, event, payload.event_id).catch(e => console.error('[SLACK-WEBHOOK] Reaction error:', e.message)));
      return json({ ok: true, event_id: payload.event_id });
    }

    // 4. file_shared ???먯뀑 ?낅줈???뚮┝
    if (event?.type === 'file_shared') {
      ctx.waitUntil(logSlackEvent(env, 'file_shared', `?뚯씪 怨듭쑀: ${event.file_id || 'unknown'}`, event.channel_id || ''));
      return json({ ok: true, event_id: payload.event_id });
    }

    // 5. 湲고? ?대깽??濡쒓퉭
    ctx.waitUntil(logSlackEvent(env, event?.type || 'unknown', `Event: ${event?.type}`, JSON.stringify(event || {}).slice(0, 500)));
    return json({ ok: true, event_type: event?.type });
  }
  return json({ ok: true });
}

async function processCommandCenterMessage(env, event, eventId) {
  const text = event.text || '';
  const userId = event.user;
  const threadTs = event.thread_ts || event.ts;

  // ?꾩?留?而ㅻ㎤??
  const lower = text.toLowerCase().trim();
  if (lower === '?꾩?留' || lower === 'help' || lower === '?') {
    const greenToken = await getSlackConfigValue(env, 'SLACK_BOT_TOKEN_GREEN');
    if (greenToken) {
      const helpText = `?쨼 *STUDIOJUN AI 遊?媛?대뱶*\n\n` +
        `?윟 *GREEN* (?꾨줎??QA/?꾨줈?뺤뀡)\n????吏꾪뻾瑜? ?먰뵾?뚮뱶 ?꾪솴, 由щ럭 ?곹깭 吏덈Ц\n???? "EP01 吏꾪뻾瑜??뚮젮以?, "?꾩옱 ?꾨줈?앺듃 ?꾪솴"\n\n` +
        `?뵶 *RED* (諛깆뿏??諛고룷/肄붾뱶)\n??Worker 諛고룷, 肄붾뱶 ?댁뒋, ?쒖뒪???곹깭\n???? "@codex 諛고룷 ?곹깭", "worker 踰꾩쟾 ?뺤씤"\n\n` +
        `?뵷 *BLUE* (援ш??쒗듃/踰덉뿭/?숆린??\n???쒗듃 ?곗씠?? 踰덉뿭, ?숆린???곹깭\n???? "@gemini ?쒗듃 ?숆린???뺤씤", "?먰뵾?뚮뱶 紐⑸줉"\n\n` +
        `??*?먮룞 湲곕뒫*\n?????좎씪 ?곹깭 蹂寃????먮룞 ?뚮┝\n????由ъ븸????由щ럭 ?뱀씤 | ?봽 ??由ы뀒?댄겕\n??留ㅼ씪 ?ㅼ쟾/?ㅽ썑 ?먮룞 釉뚮━??n\n` +
        `?뮕 ?꾨Т 吏덈Ц?대굹 ?먯쑀濡?쾶 ?대낫?몄슂!`;
      await postSlackBotMessage(greenToken, { channel: JUN_COMMAND_CENTER_ID, thread_ts: threadTs, text: helpText, unfurl_links: false });
    }
    return;
  }

  // 釉뚮젅?몄뒪?좊컢 紐⑤뱶: 3遊뉗씠 ?쒖감?곸쑝濡?媛곸옄 愿?먯뿉???섍껄 ?쒖떆
  const brainMatch = text.match(/^(brainstorm|meeting)\s*[:?]?\s*(.+)/i);
  if (brainMatch) {
    const topic = brainMatch[2].trim();
    await brainstormSession(env, topic, userId, threadTs, eventId);
    return;
  }

  const agentKey = routeToAgent(text);
  const agent = SLACK_AGENTS[agentKey];
  const token = await getSlackConfigValue(env, agent.tokenKey);
  if (!token) { console.error(`[SLACK-WEBHOOK] No token: ${agent.tokenKey}`); return; }

  // Log incoming
  try {
    await env.DB.prepare('INSERT INTO slack_events (project_id, event_type, title, body, channel_hint, status, response_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('COMMAND_CENTER', 'incoming_command', `${agent.emoji} ${agent.name} triggered`, sanitizeSlackText(text).slice(0, 500), 'jun_command_center', 'received', `event_id:${eventId} user:${userId}`)
      .run();
  } catch (e) { console.error('[SLACK-WEBHOOK] Log err:', e.message); }

  // Generate response
  let responseText;
  try { responseText = await generateSlackAgentResponse(env, agent, text, userId); }
  catch (e) { responseText = `[${agent.name}] 泥섎━ 以??ㅻ쪟: ${e.message}`; }

  // Post as bot
  await postSlackBotMessage(token, { channel: JUN_COMMAND_CENTER_ID, thread_ts: threadTs, text: responseText, unfurl_links: false });

  // Log response
  try {
    await env.DB.prepare('INSERT INTO slack_events (project_id, event_type, title, body, channel_hint, status, response_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('COMMAND_CENTER', 'agent_response', `${agent.emoji} ${agent.name} responded`, sanitizeSlackText(responseText).slice(0, 500), 'jun_command_center', 'sent', `agent:${agentKey}`)
      .run();
  } catch (e) { console.error('[SLACK-WEBHOOK] Response log err:', e.message); }

  // Chain relay: 遊??묐떟?먯꽌 @硫섏뀡 媛먯? ???대떦 遊??먮룞 ?몄텧
  const mentionMap = { '@green': 'GREEN', '@red': 'RED', '@blue': 'BLUE' };
  const lowerResp = (responseText || '').toLowerCase();
  for (const [mention, targetKey] of Object.entries(mentionMap)) {
    if (lowerResp.includes(mention) && targetKey !== agentKey) {
      try {
        const targetAgent = SLACK_AGENTS[targetKey];
        const targetToken = await getSlackConfigValue(env, targetAgent.tokenKey);
        if (!targetToken) continue;
        const chainPrompt = `[${agent.name}??媛) ?꾩엫] ?먮낯 吏덈Ц: ${text}\n${agent.name} ?듬? ?붿빟: ${responseText.slice(0, 300)}`;
        const chainResp = await generateSlackAgentResponse(env, targetAgent, chainPrompt, userId);
        await postSlackBotMessage(targetToken, { channel: JUN_COMMAND_CENTER_ID, thread_ts: threadTs, text: chainResp, unfurl_links: false });
        await logSlackEvent(env, 'chain_relay', `${agent.name}??{targetAgent.name} ?꾩엫`, `trigger:${mention} thread:${threadTs}`);
      } catch (e) { console.error(`[SLACK] Chain relay ${targetKey} err:`, e.message); }
    }
  }
}

async function brainstormSession(env, topic, userId, threadTs, eventId) {
  const perspectives = {
    GREEN: `UX/?꾨줎?몄뿏??QA 愿?먯뿉??遺꾩꽍. ?ъ슜??寃쏀뿕, UI 援ъ“, ?섏씠吏 ?먮쫫, QA 泥댄겕?ъ씤???쒖븞. 150?⑥뼱 ?대궡.`,
    RED: `諛깆뿏??API/?명봽??愿?먯뿉??遺꾩꽍. API ?붾뱶?ъ씤?? DB ?ㅽ궎留? Worker ?쇱슦?? 湲곗닠 援ы쁽 諛⑹븞 ?쒖븞. 150?⑥뼱 ?대궡.`,
    BLUE: `?곗씠??援ш??쒗듃/?뚰겕?뚮줈??愿?먯뿉??遺꾩꽍. ?곗씠??援ъ“, ?쒗듃 ?곕룞, ?먮룞???뚯씠?꾨씪???쒖븞. 150?⑥뼱 ?대궡.`
  };

  // ?쒖옉 ?뚮┝
  const greenToken = await getSlackConfigValue(env, 'SLACK_BOT_TOKEN_GREEN');
  if (greenToken) {
    await postSlackBotMessage(greenToken, {
      channel: JUN_COMMAND_CENTER_ID, thread_ts: threadTs,
      text: `?쭬 *釉뚮젅?몄뒪?좊컢 ?쒖옉* | 二쇱젣: *${topic}*\n3遊뉗씠 ?숈떆??遺꾩꽍 以?..`,
      unfurl_links: false
    });
  }

  // Phase 1: 3遊?蹂묐젹 ?몄텧 (??꾩븘??諛⑹?)
  const results = {};
  const promises = Object.entries(perspectives).map(async ([agentKey, perspective]) => {
    const agent = SLACK_AGENTS[agentKey];
    const token = await getSlackConfigValue(env, agent.tokenKey);
    if (!token) { results[agentKey] = `[${agent.name}] ?좏겙 誘몄꽕`; return; }

    const prompt = `[釉뚮젅?몄뒪?좊컢] 二쇱젣: ${topic}\n\n${perspective}`;
    let response;
    try {
      response = await generateSlackAgentResponse(env, agent, prompt, userId);
    } catch (e) {
      response = `[${agent.name}] ?묐떟 ?ㅻ쪟: ${e.message}`;
    }
    results[agentKey] = response;

    await postSlackBotMessage(token, {
      channel: JUN_COMMAND_CENTER_ID, thread_ts: threadTs,
      text: response, unfurl_links: false
    });
  });

  await Promise.all(promises);

  // Phase 2: GREEN??醫낇빀 ?뺣━
  if (greenToken) {
    const allResponses = Object.entries(results).map(([k, v]) => `[${k}]: ${v.slice(0, 300)}`).join('\n');
    const summaryPrompt = `[釉뚮젅?몄뒪?좊컢 醫낇빀] 二쇱젣: ${topic}\n\n3遊??섍껄:\n${allResponses}\n\n醫낇빀?섏뿬 ?≪뀡 ?뚮옖 ?묒꽦:\n1. ?곗꽑?쒖쐞 ?믪? ?묒뾽 3媛?n2. 利됱떆 ?쒖옉 媛?ν븳 寃?n3. ?덉긽 ?쇱젙\n100?⑥뼱 ?대궡.`;

    let summary;
    try {
      summary = await generateSlackAgentResponse(env, SLACK_AGENTS.GREEN, summaryPrompt, userId);
    } catch (e) {
      summary = `醫낇빀 ?뺣━ ?ㅻ쪟: ${e.message}`;
    }

    await postSlackBotMessage(greenToken, {
      channel: JUN_COMMAND_CENTER_ID, thread_ts: threadTs,
      text: `?뱥 *醫낇빀 ?≪뀡 ?뚮옖*\n\n${summary}`, unfurl_links: false
    });
  }

  await logSlackEvent(env, 'brainstorm', `釉뚮젅?몄뒪?좊컢: ${topic.slice(0, 100)}`, `user:${userId} agents:GREEN,RED,BLUE`);
}

async function generateSlackAgentResponse(env, agent, userText, userId) {
  const llm = agent.llm;
  const apiKey = await getSlackConfigValue(env, llm.apiKeyEnv);
  if (!apiKey) return `[${agent.name}] ${llm.apiKeyEnv} 誘몄꽕`;

  // D1 ?ㅻ뜲?댄꽣 議고쉶
  let d1Context = '';
  try { d1Context = await getD1Context(env, userText); } catch (e) { console.error('[SLACK] D1 context err:', e.message); }

  const systemPrompt = `You are ${agent.name} (${agent.emoji}), STUDIOJUN ?꾨줈?뺤뀡 ? ?꾨떞 AI ?먯씠?꾪듃.
??븷: ${agent.role}
?꾨줈?앺듃: TURBO ONE (?곕낫?? ??26遺??11遺?3D 硫붿뭅 濡쒕큸 ?좊땲硫붿씠?? 5媛?遺?? Design(肄섏뀎??, Asset(紐⑤뜽留?, Animation(Maya), RenderComp(?뚮뜑?⑹꽦), FX(?댄럺??.
?뚯씠?꾨씪?? Maya Playblast ??Seedance 2.0 AI ?뚮뜑 ??Topaz ?낆뒪耳?????⑹꽦
?명봽?? Cloudflare Workers(ES Module) + D1 + R2. Kubernetes, Docker, Prometheus, Grafana???ъ슜?섏? ?딆쓬.
?? ?쒓뎅??議대뙎留? 媛꾧껐?섏?留??듭떖 ?꾨떖.

以묒슂 洹쒖튃:
1. ?꾨옒 "?ㅼ떆媛?D1 ?곗씠?? ?뱀뀡???덈뒗 ?뺣낫留??ъ떎濡??듬???寃?
2. D1 ?곗씠?곗뿉 ?녿뒗 ?댁슜? ?덈? 異붿륫?섍굅??留뚮뱾?대궡吏 留?寃? "?대떦 ?곗씠?곌? D1???놁뒿?덈떎"?쇨퀬 ?붿쭅???듬???寃?
3. Kubernetes, Docker, Prometheus, Grafana, pod, scrape, namespace ??議댁옱?섏? ?딅뒗 ?명봽?쇰? ?멸툒?섏? 留?寃?
4. worker ?꾩옱 諛고룷 踰꾩쟾: ${WORKER_VERSION} (???뺣낫???쒖뒪?쒖뿉??吏곸젒 ?쒓났?? ?뺥솗??

而⑦뀓?ㅽ듃: ?щ옓 梨꾨꼸. JUN = 媛먮룆/?꾨줈??? 300?⑥뼱 ?대궡 ?듬?.
?ㅻⅨ 遊뉗뿉寃??꾩엫 ?꾩슂 ?? @GREEN(?꾨줎??QA), @RED(諛깆뿏??諛고룷), @BLUE(援ш??쒗듃/踰덉뿭) 硫섏뀡.
${d1Context}`;

  // Provider蹂?API ?몄텧
  if (llm.provider === 'anthropic') {
    return await callAnthropicAPI(apiKey, llm.model, systemPrompt, userText, llm.maxTokens, agent.name);
  } else if (llm.provider === 'openai') {
    return await callOpenAIAPI(apiKey, llm.model, systemPrompt, userText, llm.maxTokens, agent.name);
  } else if (llm.provider === 'google') {
    return await callGeminiAPI(apiKey, llm.model, systemPrompt, userText, llm.maxTokens, agent.name);
  }
  return `[${agent.name}] ?????녿뒗 provider: ${llm.provider}`;
}

// D1 ?ㅻ뜲?댄꽣 而⑦뀓?ㅽ듃 議고쉶
async function getD1Context(env, userText) {
  const lower = (userText || '').toLowerCase();
  const parts = [];

  // ??긽: ?꾨줈?앺듃 ?붿빟 ?듦퀎
  try {
    const stats = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM episodes WHERE archived=0) as ep_count,
        (SELECT COUNT(*) FROM shots WHERE archived=0) as shot_total,
        (SELECT COUNT(*) FROM shots WHERE archived=0 AND status='done') as shot_done,
        (SELECT COUNT(*) FROM shots WHERE archived=0 AND status='in_progress') as shot_wip,
        (SELECT COUNT(*) FROM shots WHERE archived=0 AND status='pending') as shot_pending,
        (SELECT COUNT(*) FROM assets WHERE archived=0) as asset_total,
        (SELECT COUNT(*) FROM members WHERE archived=0 AND is_active=1) as member_count
    `).first();
    if (stats) {
      const pct = stats.shot_total > 0 ? Math.round(stats.shot_done / stats.shot_total * 100) : 0;
      parts.push(`[?꾨줈?앺듃 ?꾪솴] ?먰뵾?뚮뱶:${stats.ep_count}媛? ??${stats.shot_total}媛??꾨즺${stats.shot_done}/吏꾪뻾${stats.shot_wip}/?湲?{stats.shot_pending}, ${pct}%), ?먯뀑:${stats.asset_total}媛? ?쒖꽦硫ㅻ쾭:${stats.member_count}紐`);
    }
  } catch (e) { /* skip */ }

  // ?먰뵾?뚮뱶 愿???ㅼ썙??
  if (lower.match(/episode|ep\d|sequence/)) {
    try {
      const eps = await env.DB.prepare("SELECT code, title, status FROM episodes WHERE archived=0 ORDER BY order_index LIMIT 26").all();
      if (eps.results?.length) {
        const epList = eps.results.map(e => `${e.code}(${e.status})`).join(', ');
        parts.push(`[?먰뵾?뚮뱶 紐⑸줉] ${epList}`);
      }
    } catch (e) { /* skip */ }
  }

  // ?뱀젙 ?먰뵾?뚮뱶 ???곹깭
  const epMatch = lower.match(/ep\s?(\d+)/);
  if (epMatch) {
    try {
      const epCode = `EP${epMatch[1].padStart(2, '0')}`;
      const epRow = await env.DB.prepare("SELECT id FROM episodes WHERE code = ? AND archived=0").bind(epCode).first();
      if (epRow) {
        const shotStats = await env.DB.prepare(`
          SELECT team, status, COUNT(*) as cnt FROM shots WHERE episode_id = ? AND archived=0 GROUP BY team, status ORDER BY team, status
        `).bind(epRow.id).all();
        if (shotStats.results?.length) {
          parts.push(`[${epCode} ???곹깭] ${shotStats.results.map(r => `${r.team}/${r.status}:${r.cnt}`).join(', ')}`);
        }
      }
    } catch (e) { /* skip */ }
  }

  // ?/遺??愿??
  if (lower.match(/team|member|assign/)) {
    try {
      const members = await env.DB.prepare("SELECT name, team, role, department, region FROM members WHERE archived=0 AND is_active=1 LIMIT 30").all();
      if (members.results?.length) {
        parts.push(`[??? ${members.results.map(m => `${m.name}(${m.team||''}/${m.department||''}/${m.region||'HQ'})`).join(', ')}`);
      }
    } catch (e) { /* skip */ }
  }

  // ?먯뀑 愿??
  if (lower.match(/asset|model|character|background|prop/)) {
    try {
      const assetStats = await env.DB.prepare("SELECT type, status, COUNT(*) as cnt FROM assets WHERE archived=0 GROUP BY type, status ORDER BY cnt DESC LIMIT 20").all();
      if (assetStats.results?.length) {
        parts.push(`[?먯뀑 ?꾪솴] ${assetStats.results.map(a => `${a.type}/${a.status}:${a.cnt}`).join(', ')}`);
      }
    } catch (e) { /* skip */ }
  }

  // Review check
  if (lower.match(/review|confirm|feedback/)) {
    try {
      const reviews = await env.DB.prepare("SELECT id, status, team, created_at FROM video_reviews ORDER BY created_at DESC LIMIT 5").all();
      if (reviews.results?.length) {
        parts.push(`[理쒓렐 由щ럭] ${reviews.results.map(r => `${r.id}(${r.status}/${r.team})`).join(', ')}`);
      }
    } catch (e) { /* skip */ }
  }

  // 援ш??쒗듃 罹먯떆
  if (lower.match(/sheet|schedule|progress/)) {
    try {
      const sheets = await env.DB.prepare("SELECT sheet_name, COUNT(*) as cnt, MAX(synced_at) as last_sync FROM sheets_cache GROUP BY sheet_name").all();
      if (sheets.results?.length) {
        parts.push(`[援ш??쒗듃 罹먯떆] ${sheets.results.map(s => `${s.sheet_name}:${s.cnt}??${s.last_sync ? new Date(s.last_sync).toLocaleDateString('ko') : '誘몃룞湲고솕'})`).join(', ')}`);
      }
    } catch (e) { /* skip */ }
  }

  return parts.length ? '\n\n--- ?ㅼ떆媛?D1 ?곗씠??---\n' + parts.join('\n') : '';
}

// ===== 3???LLM API ?몄텧 =====

async function callAnthropicAPI(apiKey, model, systemPrompt, userText, maxTokens, agentName) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userText }] }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Anthropic ${response.status}: ${err.slice(0, 200)}`); }
  const data = await response.json();
  return data.content?.[0]?.text || `[${agentName}] ?묐떟 ?놁쓬`;
}

async function callOpenAIAPI(apiKey, model, systemPrompt, userText, maxTokens, agentName) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }] }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`OpenAI ${response.status}: ${err.slice(0, 200)}`); }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || `[${agentName}] ?묐떟 ?놁쓬`;
}

async function callGeminiAPI(apiKey, model, systemPrompt, userText, maxTokens, agentName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userText }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Gemini ${response.status}: ${err.slice(0, 200)}`); }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || `[${agentName}] ?묐떟 ?놁쓬`;
}

async function postSlackBotMessage(token, params) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const data = await response.json();
  if (!data.ok) console.error(`[SLACK-WEBHOOK] postMessage error: ${data.error}`);
  return data;
}

// ===== Slack Event Processing Helpers =====

async function processChannelMention(env, event, eventId) {
  const text = event.text || '';
  const agentKey = routeToAgent(text);
  const agent = SLACK_AGENTS[agentKey];
  const token = await getSlackConfigValue(env, agent.tokenKey);
  if (!token) { console.error(`[SLACK-MENTION] No token: ${agent.tokenKey}`); return; }

  const threadTs = event.thread_ts || event.ts;

  // Log mention
  try {
    await env.DB.prepare('INSERT INTO slack_events (project_id, event_type, title, body, channel_hint, status, response_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('TURBO ONE', 'channel_mention', `${agent.emoji} ${agent.name} 硫섏뀡`, sanitizeSlackText(text).slice(0, 500), event.channel, 'received', `event_id:${eventId}`)
      .run();
  } catch (e) { console.error('[SLACK-MENTION] Log err:', e.message); }

  // Generate & post response
  let responseText;
  try { responseText = await generateSlackAgentResponse(env, agent, text, event.user); }
  catch (e) { responseText = `[${agent.name}] 泥섎━ 以??ㅻ쪟: ${e.message}`; }

  await postSlackBotMessage(token, { channel: event.channel, thread_ts: threadTs, text: responseText, unfurl_links: false });
}

async function processReactionEvent(env, event, eventId) {
  const reaction = event.reaction || '';
  // ??= 由щ럭 ?뱀씤, ?봽 = 由ы뀒?댄겕
  if (reaction !== 'white_check_mark' && reaction !== 'arrows_counterclockwise') return;

  const status = reaction === 'white_check_mark' ? 'confirmed' : 'retake';
  const msgTs = event.item?.ts || '';
  const channelId = event.item?.channel || '';

  // D1?먯꽌 ?대떦 硫붿떆吏? ?곌껐??由щ럭 李얠븘???곹깭 ?낅뜲?댄듃
  try {
    const review = await env.DB.prepare(
      `SELECT id FROM video_reviews WHERE slack_thread_ts = ? OR slack_message_ts = ? LIMIT 1`
    ).bind(msgTs, msgTs).first();
    if (review) {
      await env.DB.prepare(`UPDATE video_reviews SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(status, review.id).run();
      // ?뱀씤/由ы뀒?댄겕 ?뚮┝???ㅻ젅?쒖뿉 ?ъ뒪??
      const greenToken = await getSlackConfigValue(env, 'SLACK_BOT_TOKEN_GREEN');
      if (greenToken && channelId) {
        const emoji = status === 'confirmed' ? '\u2705' : '\u23f3';
        await postSlackBotMessage(greenToken, {
          channel: channelId, thread_ts: msgTs,
          text: `${emoji} 由щ럭 ${status === 'confirmed' ? '?뱀씤' : '由ы뀒?댄겕'} 泥섎━?섏뿀?듬땲?? (review #${review.id})`,
          unfurl_links: false
        });
      }
    }
  } catch (e) { console.error('[SLACK] Reaction D1 update err:', e.message); }

  await logSlackEvent(env, 'reaction_review', `由ъ븸??由щ럭 ${status}: ${msgTs}`, `user:${event.user} reaction:${reaction} channel:${channelId}`);
}

async function logSlackEvent(env, eventType, title, body) {
  try {
    await ensureSlackTables(env);
    await env.DB.prepare('INSERT INTO slack_events (project_id, event_type, title, body, channel_hint, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('TURBO ONE', eventType, sanitizeSlackText(title).slice(0, 500), sanitizeSlackText(body).slice(0, 1000), '', 'logged')
      .run();
  } catch (e) { console.error(`[SLACK-LOG] ${eventType} err:`, e.message); }
}

// ===== Helpers =====
// ===== Video Review Handlers =====
async function getReviews(req, env) {
  const user = await authenticate(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(req.url);
  const project = url.searchParams.get('project') || 'default';
  const status = url.searchParams.get('status');
  const team = url.searchParams.get('team');
  let sql = 'SELECT * FROM video_reviews WHERE project_id = ?';
  const params = [project];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (team) { sql += ' AND team = ?'; params.push(team); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ reviews: results });
}

async function createReview(req, env) {
  const user = await authenticate(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const body = await req.json();
  const now = new Date().toISOString();
  const versionNum = typeof body.version === 'number' ? body.version : parseInt(String(body.version).replace(/\D/g, '')) || 1;
  const result = await env.DB.prepare(
    `INSERT INTO video_reviews (project_id, shot_id, file_id, r2_key, filename, team, uploader_name, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(
    body.project_id || 'default', body.shot_id || '', body.file_id || null,
    body.r2_key || '', body.filename || '', body.team || '', body.uploader_name || user.name || '',
    versionNum, now, now
  ).run();

  // Slack ?먮룞 ?뚮┝: 由щ럭 ?붿껌
  sendSlackEvent(env, {
    project_id: body.project_id || 'default',
    event_type: 'review_request',
    title: `由щ럭 ?붿껌: ${body.shot_id || body.filename || 'New Review'}`,
    body: `?: ${body.team || '-'} | ?낅줈?? ${body.uploader_name || user.name || '-'} | 踰꾩쟾: v${versionNum}`,
  }).catch(() => {});

  return json({ id: result.meta.last_row_id, status: 'pending', created_at: now }, 201);
}

async function updateReview(id, req, env) {
  const user = await authenticate(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const body = await req.json();
  const now = new Date().toISOString();
  const sets = [];
  const params = [];
  for (const key of ['status', 'reviewer_name', 'feedback', 'retake_note']) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); params.push(body[key]); }
  }
  if (body.status === 'confirmed' || body.status === 'retake') {
    sets.push('reviewed_at = ?'); params.push(now);
  }
  sets.push('updated_at = ?'); params.push(now);
  params.push(parseInt(id));
  await env.DB.prepare(`UPDATE video_reviews SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  // Slack ?먮룞 ?뚮┝: 由щ럭 寃곌낵 (confirmed/retake)
  if (body.status === 'confirmed' || body.status === 'retake') {
    const emoji = body.status === 'confirmed' ? '\u2705' : '\u23f3';
    sendSlackEvent(env, {
      event_type: 'review_comment',
      title: `${emoji} 由щ럭 ${body.status === 'confirmed' ? '?뱀씤' : '由ы뀒?댄겕'}: #${id}`,
      body: `由щ럭?? ${body.reviewer_name || '-'}${body.feedback ? ` | ?쇰뱶諛? ${body.feedback}` : ''}${body.retake_note ? ` | 由ы뀒?댄겕 ?ъ쑀: ${body.retake_note}` : ''}`,
    }).catch(() => {});
  }

  return json({ ok: true });
}

async function getReviewComments(reviewId, env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM review_comments WHERE review_id = ? ORDER BY created_at ASC'
  ).bind(reviewId).all();
  return json({ comments: results });
}

async function createReviewComment(reviewId, req, env) {
  const user = await authenticate(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const body = await req.json();
  const now = new Date().toISOString();
  const authorName = user.name || user.email || user.id || 'user';
  const result = await env.DB.prepare(
    'INSERT INTO review_comments (review_id, author_name, timecode, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(parseInt(reviewId), authorName, parseFloat(body.timecode) || 0, body.text || '', now).run();
  return json({ id: result.meta.last_row_id, created_at: now }, 201);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonWithCookie(data, token, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('Set-Cookie', `sj_jwt=${token}; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax; Secure; HttpOnly`);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return new Response(JSON.stringify(data), { status, headers });
}

function redirectNoStore(location, status = 302) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  return new Response(null, { status, headers });
}

function corsHeaders(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Confirm-Deploy',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const allowed = String(env?.ALLOWED_ORIGINS || 'https://studiojun.co.kr,https://www.studiojun.co.kr')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  const origin = request?.headers?.get?.('Origin') || '';
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else if (!origin) {
    headers['Access-Control-Allow-Origin'] = allowed[0] || 'https://studiojun.co.kr';
  }
  return headers;
}

function addCors(res, request, env) {
  const headers = new Headers(res.headers);
  const cors = corsHeaders(request, env);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}

function contentTypeForKey(key) {
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  if (key.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (key.endsWith('.css')) return 'text/css; charset=utf-8';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (key.endsWith('.svg')) return 'image/svg+xml';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.ico')) return 'image/x-icon';
  if (key.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

async function logActivity(env, projectId, actorName, action, targetType, targetId, detail) {
  await env.DB.prepare(
    'INSERT INTO activity_log (project_id, actor_name, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(projectId || '', actorName || '', action || '', targetType || '', targetId || '', detail || '').run();
}

// JWT 荑좏궎 ?뚯떛
function getJwtFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/sj_jwt=([^;\s]+)/);
  return match ? match[1] : null;
}

// JWT
async function createJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyJWT(token, secret) {
  const [header, body, sig] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(sig), c => c.charCodeAt(0)), new TextEncoder().encode(`${header}.${body}`));
  if (!valid) return null;
  const payload = JSON.parse(atob(body));
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}

async function authenticate(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : getJwtFromCookie(req);
  if (!token) return null;
  return verifyJWT(token, env.JWT_SECRET);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...salt)) + ':' + btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(hash))) === hashB64;
}

// ===== Guide Video Analysis =====

async function guideCreateSession(req, env, user) {
  const { project_id, r2_key, filename, duration_sec } = await req.json();
  if (!r2_key || !filename) return json({ error: 'r2_key and filename required' }, 400);
  const id = 'gs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await env.DB.prepare(
    'INSERT INTO guide_sessions (id, project_id, r2_key, filename, duration_sec, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, project_id || 'default', r2_key, filename, duration_sec || null, 'processing', user.name || user.uid || 'unknown').run();
  return json({ id, status: 'processing' }, 201);
}

async function guideTranscript(req, env) {
  const { session_id, chunk_index, start_time, end_time, text_ko } = await req.json();
  if (!session_id || chunk_index == null || !text_ko) return json({ error: 'Missing fields' }, 400);

  const cutPattern = /cut\s*\d+|#\s*\d+/;
  const isCutCue = cutPattern.test(text_ko) ? 1 : 0;
  let cutLabel = null;
  const labelMatch = text_ko.match(/(?:cut|#)\s*(\d+)/);
  if (labelMatch) cutLabel = labelMatch[0];

  await env.DB.prepare(
    'INSERT INTO guide_segments (session_id, chunk_index, start_time, end_time, text_ko, is_cut_cue, cut_label) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(session_id, chunk_index, start_time, end_time, text_ko, isCutCue, cutLabel).run();

  if (isCutCue) {
    const cutCount = (await env.DB.prepare('SELECT COUNT(*) as cnt FROM guide_cuts WHERE session_id = ?').bind(session_id).first()).cnt;
    await env.DB.prepare(
      'INSERT INTO guide_cuts (session_id, cut_number, time_sec, source, label) VALUES (?, ?, ?, ?, ?)'
    ).bind(session_id, cutCount + 1, start_time, 'speech', cutLabel).run();
  }

  await env.DB.prepare('UPDATE guide_sessions SET completed_chunks = completed_chunks + 1 WHERE id = ?').bind(session_id).run();

  return json({ ok: true, is_cut_cue: isCutCue, cut_label: cutLabel });
}

async function guideTranslate(req, env) {
  const { session_id, segment_ids } = await req.json();
  if (!session_id || !segment_ids?.length) return json({ error: 'Missing fields' }, 400);

  const placeholders = segment_ids.map(() => '?').join(',');
  const segments = (await env.DB.prepare(
    `SELECT id, text_ko FROM guide_segments WHERE session_id = ? AND id IN (${placeholders})`
  ).bind(session_id, ...segment_ids).all()).results;

  if (!segments.length) return json({ translated: 0 });

  const textsKo = segments.map(s => s.text_ko).filter(Boolean);
  if (!textsKo.length) return json({ translated: 0 });

  const prompt = `Translate each Korean line to English and Vietnamese. Return JSON array with objects {index, en, vi}. Keep same order. Lines:\n${textsKo.map((t, i) => `${i}: ${t}`).join('\n')}`;

  const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const aiData = await aiResp.json();
  const textContent = aiData.content?.[0]?.text || '[]';

  let translations = [];
  try {
    const jsonMatch = textContent.match(/\[[\s\S]*\]/);
    if (jsonMatch) translations = JSON.parse(jsonMatch[0]);
  } catch (e) { return json({ error: 'Translation parse failed', raw: textContent }, 500); }

  let updated = 0;
  for (const t of translations) {
    const seg = segments[t.index];
    if (seg && t.en && t.vi) {
      await env.DB.prepare('UPDATE guide_segments SET text_en = ?, text_vi = ? WHERE id = ?').bind(t.en, t.vi, seg.id).run();
      updated++;
    }
  }

  return json({ translated: updated });
}

async function guideSceneCut(req, env) {
  const { session_id, time_sec, label } = await req.json();
  if (!session_id || time_sec == null) return json({ error: 'Missing fields' }, 400);

  const existing = await env.DB.prepare(
    'SELECT id FROM guide_cuts WHERE session_id = ? AND ABS(time_sec - ?) < 2'
  ).bind(session_id, time_sec).first();
  if (existing) return json({ ok: true, duplicate: true });

  const cutCount = (await env.DB.prepare('SELECT COUNT(*) as cnt FROM guide_cuts WHERE session_id = ?').bind(session_id).first()).cnt;
  await env.DB.prepare(
    'INSERT INTO guide_cuts (session_id, cut_number, time_sec, source, label) VALUES (?, ?, ?, ?, ?)'
  ).bind(session_id, cutCount + 1, time_sec, 'visual', label || null).run();

  return json({ ok: true, cut_number: cutCount + 1 });
}

async function guideGetSession(sessionId, env) {
  const session = await env.DB.prepare('SELECT * FROM guide_sessions WHERE id = ?').bind(sessionId).first();
  if (!session) return json({ error: 'Session not found' }, 404);

  const segments = (await env.DB.prepare('SELECT * FROM guide_segments WHERE session_id = ? ORDER BY start_time').bind(sessionId).all()).results;
  const cuts = (await env.DB.prepare('SELECT * FROM guide_cuts WHERE session_id = ? ORDER BY time_sec').bind(sessionId).all()).results;

  return json({ session, segments, cuts });
}

async function guideVTT(sessionId, lang, env) {
  const segments = (await env.DB.prepare('SELECT * FROM guide_segments WHERE session_id = ? ORDER BY start_time').bind(sessionId).all()).results;
  if (!segments.length) return new Response('WEBVTT\n\n', { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });

  const field = lang === 'en' ? 'text_en' : lang === 'vi' ? 'text_vi' : 'text_ko';
  let vtt = 'WEBVTT\n\n';
  segments.forEach((s, i) => {
    const text = s[field] || s.text_ko || '';
    if (!text) return;
    vtt += `${i + 1}\n${fmtVTT(s.start_time)} --> ${fmtVTT(s.end_time)}\n${text}\n\n`;
  });

  return new Response(vtt, {
    headers: {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Disposition': `attachment; filename="guide_${sessionId}_${lang}.vtt"`,
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function fmtVTT(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ===================================================================
// 媛?대뱶 鍮꾨뵒??泥섎━ API (2?쒓컙 媛먮룆 媛?대뱶 ?곸긽 ?뚯씠?꾨씪??
// Whisper STT + Claude ?붿빟/踰덉뿭 + R2 硫?고뙆???낅줈??// ===================================================================

function guideId(prefix) {
  const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const r = Math.random().toString(36).substring(2,10).toUpperCase();
  return `${prefix}_${d}_${r}`;
}

async function initGuideTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS guide_sessions (
      id TEXT PRIMARY KEY, title TEXT, episode TEXT, video_key TEXT,
      video_size INTEGER, duration_seconds REAL, total_cuts INTEGER DEFAULT 0,
      stt_status TEXT DEFAULT 'pending', cut_status TEXT DEFAULT 'pending',
      summary_status TEXT DEFAULT 'pending', translate_status TEXT DEFAULT 'pending',
      distribute_status TEXT DEFAULT 'pending', created_by TEXT,
      created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch())
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS guide_cuts (
      id TEXT PRIMARY KEY, session_id TEXT, cut_number INTEGER,
      start_time REAL, end_time REAL, duration REAL, thumbnail_key TEXT,
      transcript_ko TEXT, transcript_en TEXT, transcript_vi TEXT,
      summary_ko TEXT, summary_en TEXT, summary_vi TEXT,
      assigned_to TEXT, assigned_team TEXT, notes TEXT,
      status TEXT DEFAULT 'pending', created_at INTEGER DEFAULT (unixepoch())
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS guide_stt_chunks (
      id TEXT PRIMARY KEY, session_id TEXT, chunk_number INTEGER,
      start_time REAL, end_time REAL, text_ko TEXT, confidence REAL,
      status TEXT DEFAULT 'pending', created_at INTEGER DEFAULT (unixepoch())
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS guide_dubs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, language TEXT NOT NULL,
      provider TEXT DEFAULT 'elevenlabs', provider_job_id TEXT,
      source_key TEXT, source_url TEXT, media_key TEXT, subtitle_srt_key TEXT,
      subtitle_vtt_key TEXT, status TEXT DEFAULT 'pending', approved INTEGER DEFAULT 0,
      error_message TEXT, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(session_id, language)
    )`)
  ]);
}

function elevenLabsHeaders(env, jsonContent = true) {
  const headers = { 'xi-api-key': env.ELEVENLABS_API_KEY || '' };
  if (jsonContent) headers['Content-Type'] = 'application/json';
  return headers;
}

function srtToVtt(srtText) {
  const normalized = String(srtText || '').replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${normalized.trim()}\n`;
}

function guidePublicMediaUrl(request, key) {
  if (!key) return '';
  const url = new URL(request.url);
  return `${url.origin}/r2/download/${encodeURIComponent(String(key)).replace(/%2F/g, '/')}`;
}

async function upsertGuideDub(db, row) {
  const id = row.id || guideId('DUB');
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO guide_dubs
      (id,session_id,language,provider,provider_job_id,source_key,source_url,media_key,subtitle_srt_key,subtitle_vtt_key,status,approved,error_message,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id, language) DO UPDATE SET
      provider_job_id=excluded.provider_job_id,
      source_key=excluded.source_key,
      source_url=excluded.source_url,
      media_key=excluded.media_key,
      subtitle_srt_key=excluded.subtitle_srt_key,
      subtitle_vtt_key=excluded.subtitle_vtt_key,
      status=excluded.status,
      error_message=excluded.error_message,
      updated_at=excluded.updated_at`
  ).bind(
    id,
    row.session_id,
    row.language,
    row.provider || 'elevenlabs',
    row.provider_job_id || null,
    row.source_key || null,
    row.source_url || null,
    row.media_key || null,
    row.subtitle_srt_key || null,
    row.subtitle_vtt_key || null,
    row.status || 'pending',
    row.approved ? 1 : 0,
    row.error_message || null,
    now,
    now
  ).run();
  return id;
}

async function handleGuideAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  // ?뚯씠釉??먮룞 ?앹꽦
  await initGuideTables(db);

  if (path === '/api/guide/dub/config' && method === 'GET') {
    return json({
      success: true,
      provider: 'elevenlabs',
      configured: Boolean(env.ELEVENLABS_API_KEY),
      languages: ['en', 'vi'],
      requires_confirmation: true
    });
  }

  // --- ?몄뀡 愿由?---
  if (path === '/api/guide/session' && method === 'POST') {
    const { title, episode, duration_seconds, created_by } = await request.json();
    if (!title || !episode) return json({ error: 'title, episode ?꾩닔' }, 400);
    const id = guideId('GUIDE');
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO guide_sessions (id,title,episode,duration_seconds,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(id, title, episode, duration_seconds||0, created_by||'director', now, now).run();
    return json({ success: true, session: { id, title, episode } });
  }

  // GET /api/guide/session/:id
  const sessionMatch = path.match(/^\/api\/guide\/session\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    const session = await db.prepare('SELECT * FROM guide_sessions WHERE id=?').bind(sessionMatch[1]).first();
    if (!session) return json({ error: '?몄뀡 ?놁쓬' }, 404);
    const cuts = await db.prepare('SELECT * FROM guide_cuts WHERE session_id=? ORDER BY cut_number').bind(session.id).all();
    const dubs = await db.prepare('SELECT * FROM guide_dubs WHERE session_id=? ORDER BY language').bind(session.id).all();
    return json({ success: true, session, cuts: cuts.results, dubs: dubs.results });
  }

  const dubMatch = path.match(/^\/api\/guide\/dub\/([^/]+)$/);
  if (dubMatch && method === 'POST') {
    if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY secret is not configured' }, 503);
    const sessionId = dubMatch[1];
    const session = await db.prepare('SELECT * FROM guide_sessions WHERE id=?').bind(sessionId).first();
    if (!session) return json({ error: 'Guide session not found' }, 404);

    const body = await request.json().catch(() => ({}));
    const language = String(body.language || body.target_lang || '').toLowerCase();
    if (!['en', 'vi'].includes(language)) return json({ error: 'language must be en or vi' }, 400);
    if (!body.confirmed) return json({ error: 'confirmed=true is required before starting paid dubbing' }, 409);

    const sourceUrl = body.source_url || guidePublicMediaUrl(request, body.source_key || session.video_key);
    if (!sourceUrl) return json({ error: 'source_url or session video_key is required' }, 400);

    const dubForm = new FormData();
    dubForm.append('source_url', sourceUrl);
    dubForm.append('source_lang', body.source_lang || 'ko');
    dubForm.append('target_lang', language);
    dubForm.append('mode', body.mode || 'automatic');
    dubForm.append('num_speakers', String(body.num_speakers ?? 0));
    dubForm.append('watermark', String(body.watermark ?? false));
    dubForm.append('highest_resolution', String(body.highest_resolution ?? false));
    dubForm.append('drop_background_audio', String(body.drop_background_audio ?? false));
    dubForm.append('name', body.name || `${session.episode || 'TBO'} ${session.title || sessionId} ${language.toUpperCase()}`);

    const createRes = await fetch('https://api.elevenlabs.io/v1/dubbing', {
      method: 'POST',
      headers: elevenLabsHeaders(env, false),
      body: dubForm
    });

    const payload = await createRes.json().catch(async () => ({ error: await createRes.text() }));
    if (!createRes.ok) {
      await upsertGuideDub(db, {
        session_id: sessionId,
        language,
        source_key: body.source_key || session.video_key,
        source_url: sourceUrl,
        status: 'error',
        error_message: JSON.stringify(payload).slice(0, 900)
      });
      return json({ error: 'ElevenLabs dubbing request failed', detail: payload }, createRes.status);
    }

    const dubbingId = payload.dubbing_id || payload.id || payload.job_id;
    await upsertGuideDub(db, {
      session_id: sessionId,
      language,
      provider_job_id: dubbingId,
      source_key: body.source_key || session.video_key,
      source_url: sourceUrl,
      status: 'processing'
    });
    return json({ success: true, sessionId, language, provider: 'elevenlabs', provider_job_id: dubbingId, status: 'processing' });
  }

  const dubStatusMatch = path.match(/^\/api\/guide\/dub\/([^/]+)\/status$/);
  if (dubStatusMatch && method === 'GET') {
    const sessionId = dubStatusMatch[1];
    const language = new URL(request.url).searchParams.get('language');
    const rows = await db.prepare(
      language ? 'SELECT * FROM guide_dubs WHERE session_id=? AND language=?' : 'SELECT * FROM guide_dubs WHERE session_id=? ORDER BY language'
    ).bind(...(language ? [sessionId, language] : [sessionId])).all();

    if (env.ELEVENLABS_API_KEY) {
      for (const row of rows.results) {
        if (!row.provider_job_id || ['ready', 'approved', 'error'].includes(row.status)) continue;
        const statusRes = await fetch(`https://api.elevenlabs.io/v1/dubbing/${row.provider_job_id}`, {
          headers: elevenLabsHeaders(env, false)
        });
        if (!statusRes.ok) continue;
        const statusPayload = await statusRes.json();
        const providerStatus = statusPayload.status || statusPayload.dubbing_status || row.status;
        await db.prepare('UPDATE guide_dubs SET status=?, error_message=?, updated_at=? WHERE id=?')
          .bind(providerStatus, statusPayload.error || null, Math.floor(Date.now() / 1000), row.id).run();
      }
    }

    const latest = await db.prepare(
      language ? 'SELECT * FROM guide_dubs WHERE session_id=? AND language=?' : 'SELECT * FROM guide_dubs WHERE session_id=? ORDER BY language'
    ).bind(...(language ? [sessionId, language] : [sessionId])).all();
    return json({ success: true, dubs: latest.results });
  }

  const dubImportMatch = path.match(/^\/api\/guide\/dub\/([^/]+)\/import-results$/);
  if (dubImportMatch && method === 'POST') {
    if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY secret is not configured' }, 503);
    const sessionId = dubImportMatch[1];
    const body = await request.json().catch(() => ({}));
    const language = String(body.language || '').toLowerCase();
    if (!['en', 'vi'].includes(language)) return json({ error: 'language must be en or vi' }, 400);

    const row = await db.prepare('SELECT * FROM guide_dubs WHERE session_id=? AND language=?').bind(sessionId, language).first();
    if (!row?.provider_job_id) return json({ error: 'Dubbing job not found' }, 404);
    const session = await db.prepare('SELECT * FROM guide_sessions WHERE id=?').bind(sessionId).first();
    if (!session) return json({ error: 'Guide session not found' }, 404);

    const baseKey = `guides/${session.episode || 'TBO'}/${sessionId}`;
    const mediaRes = await fetch(`https://api.elevenlabs.io/v1/dubbing/${row.provider_job_id}/audio/${language}`, {
      headers: elevenLabsHeaders(env, false)
    });
    if (!mediaRes.ok) return json({ error: 'Failed to fetch dubbed media', detail: await mediaRes.text() }, mediaRes.status);
    const mediaBody = await mediaRes.arrayBuffer();
    const mediaKey = `${baseKey}/${language}_dub.mp4`;
    await env.ASSETS.put(mediaKey, mediaBody, { httpMetadata: { contentType: mediaRes.headers.get('Content-Type') || 'video/mp4' } });

    let srtKey = null;
    let vttKey = null;
    const srtRes = await fetch(`https://api.elevenlabs.io/v1/dubbing/${row.provider_job_id}/transcript/${language}?format=srt`, {
      headers: elevenLabsHeaders(env, false)
    });
    if (srtRes.ok) {
      const srt = await srtRes.text();
      srtKey = `${baseKey}/${language}.srt`;
      vttKey = `${baseKey}/${language}.vtt`;
      await env.ASSETS.put(srtKey, srt, { httpMetadata: { contentType: 'application/x-subrip; charset=utf-8' } });
      await env.ASSETS.put(vttKey, srtToVtt(srt), { httpMetadata: { contentType: 'text/vtt; charset=utf-8' } });
    }

    await upsertGuideDub(db, {
      id: row.id,
      session_id: sessionId,
      language,
      provider_job_id: row.provider_job_id,
      source_key: row.source_key,
      source_url: row.source_url,
      media_key: mediaKey,
      subtitle_srt_key: srtKey,
      subtitle_vtt_key: vttKey,
      status: 'ready'
    });

    return json({ success: true, sessionId, language, media_key: mediaKey, subtitle_srt_key: srtKey, subtitle_vtt_key: vttKey, status: 'ready' });
  }

  // PATCH /api/guide/session/:id
  if (sessionMatch && method === 'PATCH') {
    const updates = await request.json();
    const fields = []; const vals = [];
    for (const [k,v] of Object.entries(updates)) {
      if (['stt_status','cut_status','summary_status','translate_status','distribute_status','total_cuts','video_key','video_size'].includes(k)) {
        fields.push(`${k}=?`); vals.push(v);
      }
    }
    if (fields.length) {
      fields.push('updated_at=?'); vals.push(Math.floor(Date.now()/1000));
      vals.push(sessionMatch[1]);
      await db.prepare(`UPDATE guide_sessions SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
    }
    return json({ success: true });
  }

  // --- R2 硫?고뙆???낅줈??---
  if (path === '/api/guide/upload/init' && method === 'POST') {
    const { sessionId, filename } = await request.json();
    const key = `guides/${sessionId}/${filename || 'video.mp4'}`;
    const upload = await env.ASSETS.createMultipartUpload(key);
    return json({ success: true, uploadId: upload.uploadId, key });
  }

  if (path === '/api/guide/upload/part' && method === 'POST') {
    const url = new URL(request.url);
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = parseInt(url.searchParams.get('partNumber'));
    const key = url.searchParams.get('key');
    const upload = env.ASSETS.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ success: true, partNumber, etag: part.etag });
  }

  if (path === '/api/guide/upload/complete' && method === 'POST') {
    const { uploadId, key, parts, sessionId } = await request.json();
    const upload = env.ASSETS.resumeMultipartUpload(key, uploadId);
    await upload.complete(parts);
    if (sessionId) {
      await db.prepare('UPDATE guide_sessions SET video_key=?, updated_at=? WHERE id=?')
        .bind(key, Math.floor(Date.now()/1000), sessionId).run();
    }
    return json({ success: true, key });
  }

  if (path === '/api/guide/upload/abort' && method === 'POST') {
    const { uploadId, key } = await request.json();
    const upload = env.ASSETS.resumeMultipartUpload(key, uploadId);
    await upload.abort();
    return json({ success: true });
  }

  // --- STT (Whisper API) ---
  if (path === '/api/guide/stt/chunk' && method === 'POST') {
    const { sessionId, chunkNumber, audioBase64, format } = await request.json();
    if (!sessionId || !audioBase64) return json({ error: 'sessionId, audioBase64 ?꾩닔' }, 400);

    // base64 ??binary
    const audioBytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
    const ext = format || 'wav';

    // Whisper API ?몄텧
    const formData = new FormData();
    formData.append('file', new Blob([audioBytes], { type: `audio/${ext}` }), `chunk.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'ko');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: formData
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      return json({ error: 'Whisper API ?ㅻ쪟', detail: err }, 500);
    }

    const result = await whisperRes.json();

    // STT 泥?겕 ???
    const chunkId = guideId('STT');
    const startTime = (result.segments && result.segments[0]?.start) || 0;
    const endTime = (result.segments && result.segments[result.segments.length-1]?.end) || 0;

    await db.prepare(
      `INSERT INTO guide_stt_chunks (id,session_id,chunk_number,start_time,end_time,text_ko,confidence,status)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(chunkId, sessionId, chunkNumber||0, startTime, endTime,
      result.text, result.segments?.[0]?.avg_logprob || 0, 'complete').run();

    return json({
      success: true,
      chunk: { id: chunkId, text: result.text, segments: result.segments, duration: result.duration }
    });
  }

  // GET /api/guide/stt/status/:sessionId
  const sttStatusMatch = path.match(/^\/api\/guide\/stt\/status\/([^/]+)$/);
  if (sttStatusMatch && method === 'GET') {
    const chunks = await db.prepare(
      'SELECT * FROM guide_stt_chunks WHERE session_id=? ORDER BY chunk_number'
    ).bind(sttStatusMatch[1]).all();
    return json({ success: true, chunks: chunks.results, total: chunks.results.length });
  }

  // --- 而?愿由?---
  if (path === '/api/guide/cuts' && method === 'POST') {
    const { sessionId, cuts } = await request.json();
    if (!sessionId || !cuts?.length) return json({ error: 'sessionId, cuts[] ?꾩닔' }, 400);

    const stmts = cuts.map((cut, i) => {
      const id = guideId('CUT');
      return db.prepare(
        `INSERT INTO guide_cuts (id,session_id,cut_number,start_time,end_time,duration,status)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(id, sessionId, cut.cutNumber||i+1, cut.startTime, cut.endTime,
        (cut.endTime-cut.startTime), 'detected');
    });
    await db.batch(stmts);

    await db.prepare('UPDATE guide_sessions SET total_cuts=?, cut_status=?, updated_at=? WHERE id=?')
      .bind(cuts.length, 'complete', Math.floor(Date.now()/1000), sessionId).run();

    return json({ success: true, count: cuts.length });
  }

  // GET /api/guide/cuts/:sessionId
  const cutsMatch = path.match(/^\/api\/guide\/cuts\/([^/]+)$/);
  if (cutsMatch && method === 'GET') {
    const cuts = await db.prepare('SELECT * FROM guide_cuts WHERE session_id=? ORDER BY cut_number')
      .bind(cutsMatch[1]).all();
    return json({ success: true, cuts: cuts.results });
  }

  // --- 而룸퀎 ?몃꽕???낅줈??---
  const thumbMatch = path.match(/^\/api\/guide\/cuts\/([^/]+)\/thumbnail$/);
  if (thumbMatch && method === 'POST') {
    const cutId = thumbMatch[1];
    const cut = await db.prepare('SELECT * FROM guide_cuts WHERE id=?').bind(cutId).first();
    if (!cut) return json({ error: '而??놁쓬' }, 404);

    const { imageBase64, sessionId } = await request.json();
    const imgBytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
    const key = `guides/${sessionId || cut.session_id}/cuts/cut_${cut.cut_number}.jpg`;
    await env.ASSETS.put(key, imgBytes, { httpMetadata: { contentType: 'image/jpeg' } });
    await db.prepare('UPDATE guide_cuts SET thumbnail_key=? WHERE id=?').bind(key, cutId).run();
    return json({ success: true, key });
  }

  // --- 而룸퀎 ?붿빟 (Claude API) ---
  const summaryMatch = path.match(/^\/api\/guide\/cuts\/([^/]+)\/summary$/);
  if (summaryMatch && method === 'POST') {
    const cutId = summaryMatch[1];
    const cut = await db.prepare('SELECT * FROM guide_cuts WHERE id=?').bind(cutId).first();
    if (!cut) return json({ error: '而??놁쓬' }, 404);
    if (!cut.transcript_ko) return json({ error: '?꾩궗 ?띿뒪???놁쓬. STT瑜?癒쇱? ?ㅽ뻾?섏꽭??' }, 400);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `?ㅼ쓬? 3D ?좊땲硫붿씠??媛먮룆??媛?대뱶 ?곸긽?먯꽌 異붿텧??而?#${cut.cut_number} (${cut.start_time}s ~ ${cut.end_time}s)???뚯꽦 ?꾩궗?낅땲??

?꾩궗 ?띿뒪??
${cut.transcript_ko}

??而룹뿉 ????좊땲硫붿씠?곌? ?묒뾽?????꾩슂???듭떖 吏?쒖궗??쓣 2-3媛?遺덈┸?ъ씤?몃줈 ?붿빟?댁＜?몄슂.
移대찓???吏곸엫, 罹먮┃???곌린, ??대컢, 媛먯젙 ???좊땲硫붿씠??諛⑺뼢??吏묒쨷?섏꽭??
JSON ?뺤떇?쇰줈 ?묐떟: {"summary": "?붿빟 ?띿뒪??, "keywords": ["?ㅼ썙??", "?ㅼ썙??"]}`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const summaryText = claudeData.content?.[0]?.text || '';

    let summary, keywords;
    try {
      const parsed = JSON.parse(summaryText);
      summary = parsed.summary;
      keywords = parsed.keywords;
    } catch {
      summary = summaryText;
      keywords = [];
    }

    await db.prepare('UPDATE guide_cuts SET summary_ko=? WHERE id=?').bind(summary, cutId).run();
    return json({ success: true, summary, keywords });
  }

  // --- 而룸퀎 踰덉뿭 (Claude API: KO ??EN, VI) ---
  const translateMatch = path.match(/^\/api\/guide\/cuts\/([^/]+)\/translate$/);
  if (translateMatch && method === 'POST') {
    const cutId = translateMatch[1];
    const cut = await db.prepare('SELECT * FROM guide_cuts WHERE id=?').bind(cutId).first();
    if (!cut) return json({ error: '而??놁쓬' }, 404);

    const textToTranslate = cut.summary_ko || cut.transcript_ko;
    if (!textToTranslate) return json({ error: '踰덉뿭???띿뒪???놁쓬' }, 400);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `3D ?좊땲硫붿씠???쒖옉 而⑦뀓?ㅽ듃?먯꽌 ?ㅼ쓬 ?쒓뎅???띿뒪?몃? ?곸뼱? 踰좏듃?⑥뼱濡?踰덉뿭?섏꽭??
?좊땲硫붿씠???⑹뼱(blocking, polish, timing, spacing, arc ?????곸뼱 洹몃?濡??좎??섏꽭??

?먮Ц (?쒓뎅??:
${textToTranslate}

JSON ?뺤떇?쇰줈 ?묐떟: {"en": "?곸뼱 踰덉뿭", "vi": "踰좏듃?⑥뼱 踰덉뿭"}`
        }]
      })
    });

    const data = await claudeRes.json();
    const text = data.content?.[0]?.text || '{}';
    let en = '', vi = '';
    try { const p = JSON.parse(text); en = p.en; vi = p.vi; } catch { en = text; }

    await db.prepare('UPDATE guide_cuts SET transcript_en=?, transcript_vi=?, summary_en=?, summary_vi=? WHERE id=?')
      .bind(en, vi, en, vi, cutId).run();
    return json({ success: true, en, vi });
  }

  // --- 諛곕텇 (Distribution) ---
  const distributeMatch = path.match(/^\/api\/guide\/distribute\/([^/]+)$/);
  if (distributeMatch && method === 'POST') {
    const sessionId = distributeMatch[1];
    const { assignments } = await request.json();
    // assignments: [{ cutId, memberId, team }]

    if (!assignments?.length) return json({ error: 'assignments[] ?꾩닔' }, 400);

    const stmts = assignments.map(a =>
      db.prepare('UPDATE guide_cuts SET assigned_to=?, assigned_team=?, status=? WHERE id=?')
        .bind(a.memberId, a.team || 'animation', 'assigned', a.cutId)
    );
    await db.batch(stmts);

    await db.prepare('UPDATE guide_sessions SET distribute_status=?, updated_at=? WHERE id=?')
      .bind('complete', Math.floor(Date.now()/1000), sessionId).run();

    return json({ success: true, assigned: assignments.length });
  }

  // --- ?꾩껜 ?⑦궎吏 議고쉶 ---
  const packageMatch = path.match(/^\/api\/guide\/package\/([^/]+)$/);
  if (packageMatch && method === 'GET') {
    const sessionId = packageMatch[1];
    const session = await db.prepare('SELECT * FROM guide_sessions WHERE id=?').bind(sessionId).first();
    if (!session) return json({ error: '?몄뀡 ?놁쓬' }, 404);

    const cuts = await db.prepare('SELECT * FROM guide_cuts WHERE session_id=? ORDER BY cut_number')
      .bind(sessionId).all();
    const sttChunks = await db.prepare('SELECT * FROM guide_stt_chunks WHERE session_id=? ORDER BY chunk_number')
      .bind(sessionId).all();

    return json({
      success: true,
      package: {
        session,
        cuts: cuts.results,
        stt_chunks: sttChunks.results,
        stats: {
          total_cuts: cuts.results.length,
          summarized: cuts.results.filter(c => c.summary_ko).length,
          translated: cuts.results.filter(c => c.transcript_en).length,
          assigned: cuts.results.filter(c => c.assigned_to).length
        }
      }
    });
  }

  // --- STT 寃곌낵瑜?而룹뿉 留ㅽ븨 ---
  if (path === '/api/guide/stt/map-to-cuts' && method === 'POST') {
    const { sessionId } = await request.json();
    const cuts = await db.prepare('SELECT * FROM guide_cuts WHERE session_id=? ORDER BY cut_number').bind(sessionId).all();
    const chunks = await db.prepare('SELECT * FROM guide_stt_chunks WHERE session_id=? ORDER BY start_time').bind(sessionId).all();

    const stmts = [];
    for (const cut of cuts.results) {
      // ?대떦 而??쒓컙踰붿쐞???대떦?섎뒗 STT ?띿뒪???섏쭛
      const texts = chunks.results
        .filter(ch => ch.start_time < cut.end_time && ch.end_time > cut.start_time)
        .map(ch => ch.text_ko)
        .filter(Boolean);
      if (texts.length) {
        stmts.push(
          db.prepare('UPDATE guide_cuts SET transcript_ko=? WHERE id=?')
            .bind(texts.join(' '), cut.id)
        );
      }
    }
    if (stmts.length) await db.batch(stmts);

    await db.prepare('UPDATE guide_sessions SET stt_status=?, updated_at=? WHERE id=?')
      .bind('mapped', Math.floor(Date.now()/1000), sessionId).run();

    return json({ success: true, mapped: stmts.length });
  }

  return json({ error: '媛?대뱶 API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// ===================================================================
// Storyboard Review API ??而룸퀎 ?뚮젅?대툝?쇱뒪??由щ럭 + 踰꾩쟾 鍮꾧탳 + 肄붾찘??// D1 ???+ R2 ?곸긽 ?ㅽ넗由ъ? + ??理쒖쟻??而⑤쾭??// ===================================================================

function sbId(prefix) {
  const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const r = Math.random().toString(36).substring(2,10).toUpperCase();
  return `${prefix}_${d}_${r}`;
}

async function initStoryboardTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS sb_episodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    episode_number INTEGER DEFAULT 1,
    total_cuts INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_by TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS sb_cuts (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    cut_number INTEGER NOT NULL,
    shot_id TEXT,
    dept TEXT DEFAULT 'Animation',
    status TEXT DEFAULT 'wip',
    duration REAL DEFAULT 0,
    description TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (episode_id) REFERENCES sb_episodes(id)
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS sb_versions (
    id TEXT PRIMARY KEY,
    cut_id TEXT NOT NULL,
    version_number INTEGER DEFAULT 1,
    r2_key TEXT,
    r2_key_thumb TEXT,
    filename TEXT,
    file_size INTEGER DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration REAL DEFAULT 0,
    fps REAL DEFAULT 24,
    codec TEXT DEFAULT 'h264',
    is_optimized INTEGER DEFAULT 0,
    uploaded_by TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (cut_id) REFERENCES sb_cuts(id)
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS sb_comments (
    id TEXT PRIMARY KEY,
    cut_id TEXT NOT NULL,
    version_id TEXT,
    author_name TEXT NOT NULL,
    author_role TEXT,
    frame_number INTEGER,
    timecode TEXT,
    text TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    parent_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (cut_id) REFERENCES sb_cuts(id)
  )`).run();
}

async function handleStoryboardAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;
  await initStoryboardTables(db);

  const user = await authenticateAny(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ===== EPISODES =====

  // POST /api/storyboard/episodes ???먰뵾?뚮뱶 ?앹꽦
  if (path === '/api/storyboard/episodes' && method === 'POST') {
    const body = await request.json();
    const id = sbId('EP');
    await db.prepare(
      `INSERT INTO sb_episodes (id, project_id, title, episode_number, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(id, body.project_id || 'default', body.title || '???먰뵾?뚮뱶', body.episode_number || 1, user.name || user.email || user.id || 'unknown').run();
    return json({ success: true, id });
  }

  // GET /api/storyboard/episodes ???먰뵾?뚮뱶 紐⑸줉
  if (path === '/api/storyboard/episodes' && method === 'GET') {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id') || 'default';
    const rows = await db.prepare(
      'SELECT * FROM sb_episodes WHERE project_id=? AND status=? ORDER BY episode_number'
    ).bind(projectId, 'active').all();
    return json({ success: true, episodes: rows.results });
  }

  // GET /api/storyboard/episodes/:id ???먰뵾?뚮뱶 ?곸꽭
  const epDetailMatch = path.match(/^\/api\/storyboard\/episodes\/([^/]+)$/);
  if (epDetailMatch && method === 'GET') {
    const row = await db.prepare('SELECT * FROM sb_episodes WHERE id=?').bind(epDetailMatch[1]).first();
    if (!row) return json({ error: 'Episode not found' }, 404);
    return json({ success: true, episode: row });
  }

  // PUT /api/storyboard/episodes/:id ???먰뵾?뚮뱶 ?섏젙
  if (epDetailMatch && method === 'PUT') {
    const body = await request.json();
    const sets = [];
    const vals = [];
    if (body.title) { sets.push('title=?'); vals.push(body.title); }
    if (body.status) { sets.push('status=?'); vals.push(body.status); }
    if (body.episode_number) { sets.push('episode_number=?'); vals.push(body.episode_number); }
    sets.push('updated_at=unixepoch()');
    vals.push(epDetailMatch[1]);
    await db.prepare(`UPDATE sb_episodes SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
    return json({ success: true });
  }

  // ===== CUTS =====

  // POST /api/storyboard/cuts ??而??앹꽦 (?⑥씪 ?먮뒗 踰뚰겕)
  if (path === '/api/storyboard/cuts' && method === 'POST') {
    const body = await request.json();

    if (body.cuts && Array.isArray(body.cuts)) {
      // 踰뚰겕 ?앹꽦
      const stmts = body.cuts.map((cut, i) => {
        const id = sbId('CUT');
        return db.prepare(
          `INSERT INTO sb_cuts (id, episode_id, cut_number, shot_id, dept, description)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, cut.episode_id || body.episode_id, cut.cut_number || i + 1, cut.shot_id || null, cut.dept || 'Animation', cut.description || '');
      });
      await db.batch(stmts);
      // ?먰뵾?뚮뱶 而????낅뜲?댄듃
      await db.prepare('UPDATE sb_episodes SET total_cuts=(SELECT COUNT(*) FROM sb_cuts WHERE episode_id=?), updated_at=unixepoch() WHERE id=?')
        .bind(body.episode_id, body.episode_id).run();
      return json({ success: true, count: body.cuts.length });
    }

    // ?⑥씪 ?앹꽦
    const id = sbId('CUT');
    await db.prepare(
      `INSERT INTO sb_cuts (id, episode_id, cut_number, shot_id, dept, description)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, body.episode_id, body.cut_number || 1, body.shot_id || null, body.dept || 'Animation', body.description || '').run();
    await db.prepare('UPDATE sb_episodes SET total_cuts=(SELECT COUNT(*) FROM sb_cuts WHERE episode_id=?), updated_at=unixepoch() WHERE id=?')
      .bind(body.episode_id, body.episode_id).run();
    return json({ success: true, id });
  }

  // GET /api/storyboard/cuts?episode_id=xxx ??而?紐⑸줉 (踰꾩쟾 ?ы븿)
  // GET /api/storyboard/cuts?project=xxx ???꾨줈?앺듃 ?꾩껜 而?(AI 紐⑤뱢??
  if (path === '/api/storyboard/cuts' && method === 'GET') {
    const url = new URL(request.url);
    const episodeId = url.searchParams.get('episode_id');
    const projectId = url.searchParams.get('project');

    let cuts;
    if (episodeId) {
      cuts = await db.prepare(
        'SELECT * FROM sb_cuts WHERE episode_id=? ORDER BY cut_number'
      ).bind(episodeId).all();
    } else if (projectId) {
      cuts = await db.prepare(
        'SELECT c.* FROM sb_cuts c LEFT JOIN sb_episodes e ON c.episode_id=e.id WHERE e.project_id=? OR c.project_id=? ORDER BY c.episode_id, c.cut_number'
      ).bind(projectId, projectId).all();
    } else {
      return json({ error: 'episode_id ?먮뒗 project ?꾩닔' }, 400);
    }

    // 媛?而룹쓽 理쒖떊 踰꾩쟾 ?뺣낫 ?ы븿
    const cutIds = cuts.results.map(c => c.id);
    let versions = [];
    if (cutIds.length > 0) {
      const placeholders = cutIds.map(() => '?').join(',');
      versions = (await db.prepare(
        `SELECT * FROM sb_versions WHERE cut_id IN (${placeholders}) ORDER BY version_number DESC`
      ).bind(...cutIds).all()).results;
    }

    // 而룸퀎 肄붾찘????
    let commentCounts = [];
    if (cutIds.length > 0) {
      const placeholders = cutIds.map(() => '?').join(',');
      commentCounts = (await db.prepare(
        `SELECT cut_id, COUNT(*) as count FROM sb_comments WHERE cut_id IN (${placeholders}) GROUP BY cut_id`
      ).bind(...cutIds).all()).results;
    }

    const cutData = cuts.results.map(cut => ({
      ...cut,
      versions: versions.filter(v => v.cut_id === cut.id),
      comment_count: commentCounts.find(c => c.cut_id === cut.id)?.count || 0
    }));

    return json({ success: true, cuts: cutData });
  }

  // GET /api/storyboard/cuts/:id ??而??곸꽭 (踰꾩쟾 + 肄붾찘???ы븿)
  const cutDetailMatch = path.match(/^\/api\/storyboard\/cuts\/([^/]+)$/);
  if (cutDetailMatch && method === 'GET') {
    const cut = await db.prepare('SELECT * FROM sb_cuts WHERE id=?').bind(cutDetailMatch[1]).first();
    if (!cut) return json({ error: 'Cut not found' }, 404);
    const versions = (await db.prepare('SELECT * FROM sb_versions WHERE cut_id=? ORDER BY version_number DESC').bind(cut.id).all()).results;
    const comments = (await db.prepare('SELECT * FROM sb_comments WHERE cut_id=? ORDER BY created_at DESC').bind(cut.id).all()).results;
    return json({ success: true, cut: { ...cut, versions, comments } });
  }

  // PUT /api/storyboard/cuts/:id ??而??곹깭 ?낅뜲?댄듃
  const cutUpdateMatch = path.match(/^\/api\/storyboard\/cuts\/([^/]+)$/);
  if (cutUpdateMatch && method === 'PUT') {
    const body = await request.json();
    const sets = [];
    const vals = [];
    if (body.status) { sets.push('status=?'); vals.push(body.status); }
    if (body.dept) { sets.push('dept=?'); vals.push(body.dept); }
    if (body.description !== undefined) { sets.push('description=?'); vals.push(body.description); }
    if (body.duration) { sets.push('duration=?'); vals.push(body.duration); }
    if (body.ai_image_url !== undefined) { sets.push('ai_image_url=?'); vals.push(body.ai_image_url); }
    if (body.ai_image_prompt !== undefined) { sets.push('ai_image_prompt=?'); vals.push(body.ai_image_prompt); }
    if (body.ai_image_model !== undefined) { sets.push('ai_image_model=?'); vals.push(body.ai_image_model); }
    if (body.ai_image_r2_key !== undefined) { sets.push('ai_image_r2_key=?'); vals.push(body.ai_image_r2_key); }
    sets.push('updated_at=unixepoch()');
    vals.push(cutUpdateMatch[1]);
    await db.prepare(`UPDATE sb_cuts SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
    return json({ success: true });
  }

  // ===== VERSIONS (?곸긽 ?낅줈?? =====

  // POST /api/storyboard/upload ???뚮젅?대툝?쇱뒪???곸긽 ?낅줈??+ R2 ???
  if (path === '/api/storyboard/upload' && method === 'POST') {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return json({ error: 'file ?꾩닔' }, 400);

      const cutId = formData.get('cut_id');
      const episodeId = formData.get('episode_id');
      const versionNum = parseInt(formData.get('version') || '1');
      if (!cutId) return json({ error: 'cut_id ?꾩닔' }, 400);

      const filename = file.name || `playblast_${Date.now()}.mp4`;
      const r2Key = `storyboard/${episodeId || 'default'}/${cutId}/${versionNum}_${filename}`;

      // R2 ?낅줈??
      await env.ASSETS.put(r2Key, file, {
        httpMetadata: { contentType: file.type || 'video/mp4' }
      });

      // DB ???
      const id = sbId('VER');
      await db.prepare(
        `INSERT INTO sb_versions (id, cut_id, version_number, r2_key, filename, file_size, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, cutId, versionNum, r2Key, filename, file.size || 0, user.name || user.email || user.id || 'unknown').run();

      // 而?duration ?낅뜲?댄듃 (float濡??꾨떖??寃쎌슦)
      const dur = parseFloat(formData.get('duration') || '0');
      if (dur > 0) {
        await db.prepare('UPDATE sb_cuts SET duration=?, updated_at=unixepoch() WHERE id=?').bind(dur, cutId).run();
      }

      return json({
        success: true,
        version: {
          id, cut_id: cutId, version_number: versionNum,
          r2_key: r2Key, url: `/r2/download/${r2Key}`,
          filename, size: file.size
        }
      }, 201);
    }

    // Raw body ?낅줈??(???뚯씪)
    const url = new URL(request.url);
    const cutId = url.searchParams.get('cut_id');
    const versionNum = parseInt(url.searchParams.get('version') || '1');
    const filename = url.searchParams.get('filename') || `playblast_${Date.now()}.mp4`;
    const episodeId = url.searchParams.get('episode_id') || 'default';
    if (!cutId) return json({ error: 'cut_id ?꾩닔' }, 400);

    const r2Key = `storyboard/${episodeId}/${cutId}/${versionNum}_${filename}`;
    const body = await request.arrayBuffer();
    await env.ASSETS.put(r2Key, body, {
      httpMetadata: { contentType: contentType.includes('video/') ? contentType : 'video/mp4' }
    });

    const id = sbId('VER');
    await db.prepare(
      `INSERT INTO sb_versions (id, cut_id, version_number, r2_key, filename, file_size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, cutId, versionNum, r2Key, filename, body.byteLength, user.name || user.email || user.id || 'unknown').run();

    return json({
      success: true,
      version: { id, cut_id: cutId, version_number: versionNum, r2_key: r2Key, url: `/r2/download/${r2Key}`, filename, size: body.byteLength }
    }, 201);
  }

  // POST /api/storyboard/upload-bulk ???щ윭 而??쇨큵 ?낅줈??(硫?고뙆??
  if (path === '/api/storyboard/upload-bulk' && method === 'POST') {
    const formData = await request.formData();
    const episodeId = formData.get('episode_id');
    if (!episodeId) return json({ error: 'episode_id ?꾩닔' }, 400);

    const results = [];
    // ?뚯씪 ?대쫫 ?⑦꽩: CUT_001_v1.mp4, CUT_002_v2.mp4 ??
    for (const [key, file] of formData.entries()) {
      if (key === 'episode_id') continue;
      if (!(file instanceof File)) continue;

      const match = file.name.match(/(?:CUT|cut)[_\s]*(\d+)[_\s]*v?(\d+)?/i);
      const cutNum = match ? parseInt(match[1]) : results.length + 1;
      const verNum = match && match[2] ? parseInt(match[2]) : 1;

      // 而룹씠 ?놁쑝硫??먮룞 ?앹꽦
      let cut = await db.prepare('SELECT id FROM sb_cuts WHERE episode_id=? AND cut_number=?').bind(episodeId, cutNum).first();
      if (!cut) {
        const cutId = sbId('CUT');
        await db.prepare('INSERT INTO sb_cuts (id, episode_id, cut_number) VALUES (?, ?, ?)').bind(cutId, episodeId, cutNum).run();
        cut = { id: cutId };
      }

      const r2Key = `storyboard/${episodeId}/${cut.id}/${verNum}_${file.name}`;
      await env.ASSETS.put(r2Key, file, { httpMetadata: { contentType: file.type || 'video/mp4' } });

      const verId = sbId('VER');
      await db.prepare(
        'INSERT INTO sb_versions (id, cut_id, version_number, r2_key, filename, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(verId, cut.id, verNum, r2Key, file.name, file.size || 0, user.name || user.email || user.id || 'unknown').run();

      results.push({ cut_id: cut.id, cut_number: cutNum, version: verNum, filename: file.name });
    }

    // ?먰뵾?뚮뱶 而????낅뜲?댄듃
    await db.prepare('UPDATE sb_episodes SET total_cuts=(SELECT COUNT(*) FROM sb_cuts WHERE episode_id=?), updated_at=unixepoch() WHERE id=?')
      .bind(episodeId, episodeId).run();

    return json({ success: true, uploaded: results, count: results.length });
  }

  // GET /api/storyboard/stream/:r2key ??鍮꾨뵒???ㅽ듃由щ컢 (Range 吏??
  if (path.startsWith('/api/storyboard/stream/') && method === 'GET') {
    const r2Key = path.replace('/api/storyboard/stream/', '');
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      const object = await env.ASSETS.get(r2Key, { range: request.headers });
      if (!object) return json({ error: 'File not found' }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }

    const object = await env.ASSETS.get(r2Key);
    if (!object) return json({ error: 'File not found' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Accept-Ranges', 'bytes');
    return new Response(object.body, { status: 200, headers });
  }

  // ===== COMMENTS =====

  // POST /api/storyboard/comments ??肄붾찘???앹꽦
  if (path === '/api/storyboard/comments' && method === 'POST') {
    const body = await request.json();
    if (!body.cut_id || !body.text) return json({ error: 'cut_id, text ?꾩닔' }, 400);

    const id = sbId('CMT');
    await db.prepare(
      `INSERT INTO sb_comments (id, cut_id, version_id, author_name, author_role, frame_number, timecode, text, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, body.cut_id, body.version_id || null, user.name || user.email || user.id || 'unknown',
      user.role || body.role || 'member', body.frame_number || null,
      body.timecode || null, body.text, body.parent_id || null).run();
    return json({ success: true, id });
  }

  // GET /api/storyboard/comments?cut_id=xxx ??肄붾찘??議고쉶
  if (path === '/api/storyboard/comments' && method === 'GET') {
    const url = new URL(request.url);
    const cutId = url.searchParams.get('cut_id');
    if (!cutId) return json({ error: 'cut_id ?꾩닔' }, 400);

    const versionId = url.searchParams.get('version_id');
    let q = 'SELECT * FROM sb_comments WHERE cut_id=?';
    const params = [cutId];
    if (versionId) { q += ' AND version_id=?'; params.push(versionId); }
    q += ' ORDER BY created_at DESC';

    const rows = await db.prepare(q).bind(...params).all();
    return json({ success: true, comments: rows.results });
  }

  // PUT /api/storyboard/comments/:id ??肄붾찘???곹깭 蹂寃?(?닿껐/誘명빐寃?
  const cmtUpdateMatch = path.match(/^\/api\/storyboard\/comments\/([^/]+)$/);
  if (cmtUpdateMatch && method === 'PUT') {
    const body = await request.json();
    if (body.status) {
      await db.prepare('UPDATE sb_comments SET status=? WHERE id=?').bind(body.status, cmtUpdateMatch[1]).run();
    }
    return json({ success: true });
  }

  // ===== STATS =====

  // GET /api/storyboard/stats?episode_id=xxx ???먰뵾?뚮뱶 ?듦퀎
  if (path === '/api/storyboard/stats' && method === 'GET') {
    const url = new URL(request.url);
    const episodeId = url.searchParams.get('episode_id');
    if (!episodeId) return json({ error: 'episode_id ?꾩닔' }, 400);

    const total = await db.prepare('SELECT COUNT(*) as c FROM sb_cuts WHERE episode_id=?').bind(episodeId).first();
    const byStatus = await db.prepare(
      'SELECT status, COUNT(*) as c FROM sb_cuts WHERE episode_id=? GROUP BY status'
    ).bind(episodeId).all();
    const byDept = await db.prepare(
      'SELECT dept, COUNT(*) as c FROM sb_cuts WHERE episode_id=? GROUP BY dept'
    ).bind(episodeId).all();
    const totalComments = await db.prepare(
      'SELECT COUNT(*) as c FROM sb_comments WHERE cut_id IN (SELECT id FROM sb_cuts WHERE episode_id=?)'
    ).bind(episodeId).first();
    const openComments = await db.prepare(
      "SELECT COUNT(*) as c FROM sb_comments WHERE status='open' AND cut_id IN (SELECT id FROM sb_cuts WHERE episode_id=?)"
    ).bind(episodeId).first();

    return json({
      success: true,
      stats: {
        total_cuts: total?.c || 0,
        by_status: byStatus.results,
        by_dept: byDept.results,
        total_comments: totalComments?.c || 0,
        open_comments: openComments?.c || 0
      }
    });
  }

  return json({ error: '?ㅽ넗由щ낫??API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// ===================================================================
// Google Sheets ?곕룞 API
// 援ш??쒗듃 ?곗씠?곕? D1 罹먯떆濡??숆린?뷀븯????쒕낫?쒖뿉 ?쒖떆
// ===================================================================

// TBO ?꾨줈?앺듃 援ш??쒗듃 ID 留ㅽ븨
const TBO_SHEETS = {
  assets:     '12P26Fv8s9qlh_YjDqmZSVuZQIA9JEhdzxaA6GDohxvk',
  ani:        '1MZ-2FVtwCdjsHG4rj9dvpfmX-McVe7aMi-wWoKi4SSI',
  schedule:   '1mSOrl1eYWuWjfgIBdUCNC064D7U45-EH32PLY3t4pnc',
  final:      '1cxUQqUUa8Hpu6EujXt1p2PZf-sKEz7PqWYajIL897Uo',
  abanu:      '1Sb7f5-LdNEvdTDlAMUBMk8hahRmgmd8he30C3gdW6bI'
};

const TBO_SHEET_WRITE_POLICIES = {
  ani: {
    EP101: { updateColumns: [[21, 25]], labels: ['U:Y feedback columns'] },
    EP102: { updateColumns: [[10, 12]], labels: ['J:L feedback columns'] },
  },
};

function columnLettersToNumber(letters) {
  let n = 0;
  for (const ch of String(letters || '').toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    n = n * 26 + (code - 64);
  }
  return n;
}

function parseA1Columns(range) {
  const bare = String(range || '').split('!').pop().replace(/\$/g, '').trim();
  const match = bare.match(/^([A-Za-z]+)(?:\d+)?(?::([A-Za-z]+)?(?:\d+)?)?$/);
  if (!match) return null;
  const start = columnLettersToNumber(match[1]);
  const end = columnLettersToNumber(match[2] || match[1]);
  if (!start || !end) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function validateSheetWritePolicy({ sheetKey, tabName, mode, range }) {
  if (mode !== 'update') return null;
  const policy = TBO_SHEET_WRITE_POLICIES[sheetKey]?.[tabName];
  if (!policy) return null;
  const cols = parseA1Columns(range);
  if (!cols) return `Unsupported range for ${sheetKey}/${tabName}. Use an explicit A1 column range like U7 or J8.`;
  const allowed = policy.updateColumns.some(([start, end]) => cols.start >= start && cols.end <= end);
  if (!allowed) {
    return `${sheetKey}/${tabName} updates are limited to ${policy.labels.join(', ')}. Requested range: ${range}`;
  }
  return null;
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function parseGoogleServiceAccount(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY must contain client_email and private_key');
  }
  parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
  return parsed;
}

async function getGoogleSheetsAccessToken(env) {
  const serviceAccount = parseGoogleServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_KEY || '');
  if (!serviceAccount) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || `Google token HTTP ${tokenRes.status}`);
  }
  return tokenData.access_token;
}

function normalizeSheetValues(body) {
  if (Array.isArray(body.values)) {
    return Array.isArray(body.values[0]) ? body.values : [body.values];
  }
  if (Object.prototype.hasOwnProperty.call(body, 'value')) return [[body.value]];
  if (body.row && typeof body.row === 'object') return [Object.values(body.row)];
  if (body.item && typeof body.item === 'object') return [Object.values(body.item)];
  return [];
}

function quoteSheetRange(tabName, range) {
  const safeTab = String(tabName).replace(/'/g, "''");
  if (range && String(range).includes('!')) return String(range);
  return `'${safeTab}'!${range || 'A:ZZ'}`;
}

async function writeGoogleSheetDirect(env, { sheetKey, tabName, mode, range, values }) {
  const spreadsheetId = TBO_SHEETS[sheetKey];
  const accessToken = await getGoogleSheetsAccessToken(env);
  if (!accessToken) return { queued: true, reason: 'GOOGLE_SERVICE_ACCOUNT_KEY not configured' };
  if (!values.length) throw new Error('values required');

  const a1Range = quoteSheetRange(tabName, range);
  const encodedRange = encodeURIComponent(a1Range);
  const isAppend = mode === 'append';
  const endpoint = isAppend
    ? `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
    : `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?valueInputOption=USER_ENTERED`;
  const resp = await fetch(endpoint, {
    method: isAppend ? 'POST' : 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(result.error?.message || `Google Sheets HTTP ${resp.status}`);
  return result;
}

async function handleSheetsAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;
  const url = new URL(request.url);

  // ?뚯씠釉??앹꽦
  await db.prepare(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS sheets_cache (
    sheet_key TEXT, tab_name TEXT, data TEXT, row_count INTEGER DEFAULT 0,
    synced_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (sheet_key, tab_name)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS sheet_write_queue (
    id TEXT PRIMARY KEY,
    sheet_key TEXT NOT NULL,
    tab_name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'append',
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_by TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`).run();

  // Google API ??議고쉶
  async function getGoogleApiKey() {
    return env.GOOGLE_API_KEY || null;
  }

  // POST /api/sheets/config ??Google API ?????
  if (path === '/api/sheets/config' && method === 'POST') {
    return json({ error: 'Google API key must be configured as Worker Secret GOOGLE_API_KEY. D1 app_config storage is disabled.' }, 410);
  }

  // GET /api/sheets/config ?????ㅼ젙 ?щ?
  if (path === '/api/sheets/config' && method === 'GET') {
    const key = await getGoogleApiKey();
    return json({
      configured: !!key,
      masked: key ? '****' + key.slice(-4) : null,
      write_configured: !!env.GOOGLE_SERVICE_ACCOUNT_KEY,
      write_mode: env.GOOGLE_SERVICE_ACCOUNT_KEY ? 'google_sheets_api_v4' : 'queue_only',
      sheets: Object.keys(TBO_SHEETS)
    });
  }

  // GET/POST /api/sheets/writeback-config ??Apps Script writeback bridge config.
  if (path === '/api/sheets/writeback-config') {
    const user = await authenticateAny(request, env);
    const role = String(user?.role || '').toLowerCase();
    if (!user || !['admin', 'pd', 'producer'].includes(role)) {
      return json({ error: 'Admin/PD only' }, 403);
    }

    if (method === 'GET') {
      const configuredUrl = env.SHEETS_WRITEBACK_URL || '';
      const configuredKey = env.SHEETS_WRITEBACK_KEY || '';
      return json({
        configured: !!configuredUrl && !!configuredKey,
        url_configured: !!configuredUrl,
        key_configured: !!configuredKey,
        key_masked: configuredKey ? '****' + configuredKey.slice(-4) : null
      });
    }

    if (method === 'POST') {
      return json({ error: 'Sheets writeback config must be configured as Worker Secrets SHEETS_WRITEBACK_URL and SHEETS_WRITEBACK_KEY. D1 app_config storage is disabled.' }, 410);
    }
  }

  if (path === '/api/sheets/sync' && method === 'POST') {
    const apiKey = await getGoogleApiKey();
    if (!apiKey) return json({ error: 'Google API key must be configured as Worker Secret GOOGLE_API_KEY.' }, 400);

    const body = await request.json().catch(() => ({}));
    const sheetKeys = Object.keys(TBO_SHEETS);
    const targetSheet = String(body.sheet || url.searchParams.get('sheet') || sheetKeys[0]).trim();
    const targetTab = String(body.tab || url.searchParams.get('tab') || '').trim();
    if (!TBO_SHEETS[targetSheet]) {
      return json({ error: 'Unknown sheet: ' + targetSheet, available_sheets: sheetKeys }, 400);
    }

    const spreadsheetId = TBO_SHEETS[targetSheet];
    const results = {};
    try {
      const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title&key=${apiKey}`;
      const metaResp = await fetch(metaUrl);
      if (!metaResp.ok) {
        return json({ success: false, sheet: targetSheet, error: `metadata failed (${metaResp.status})`, detail: await metaResp.text() }, 502);
      }
      const meta = await metaResp.json();
      const tabs = (meta.sheets || []).map(s => s.properties.title);
      const tabsToSync = targetTab ? tabs.filter(t => t === targetTab) : tabs;
      const tabResults = {};
      const MAX_BATCH = 35;
      for (let i = 0; i < tabsToSync.length && i < MAX_BATCH; i++) {
        const tab = tabsToSync[i];
        try {
          const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent("'" + tab + "'")}?key=${apiKey}`;
          const dataResp = await fetch(dataUrl);
          if (!dataResp.ok) {
            tabResults[tab] = { error: `data failed (${dataResp.status})` };
            continue;
          }
          const sheetData = await dataResp.json();
          const rows = sheetData.values || [];
          await db.prepare(
            "INSERT OR REPLACE INTO sheets_cache (sheet_key, tab_name, data, row_count, synced_at) VALUES (?,?,?,?,unixepoch())"
          ).bind(targetSheet, tab, JSON.stringify(rows), rows.length).run();
          tabResults[tab] = { rows: rows.length, synced: true };
        } catch (e) {
          tabResults[tab] = { error: e.message };
        }
      }
      const remaining = tabsToSync.length > MAX_BATCH ? tabsToSync.length - MAX_BATCH : 0;
      results[targetSheet] = { tabs: tabResults, total_tabs: tabs.length, synced_count: Object.keys(tabResults).length, remaining };
    } catch (e) {
      results[targetSheet] = { error: e.message };
    }

    const currentIndex = sheetKeys.indexOf(targetSheet);
    return json({
      success: true,
      partial: true,
      synced_sheet: targetSheet,
      next_sheet: currentIndex >= 0 && currentIndex < sheetKeys.length - 1 ? sheetKeys[currentIndex + 1] : null,
      available_sheets: sheetKeys,
      results
    });
  }

  // POST /api/sheets/sync ???뱀젙 ?쒗듃 ?먮뒗 ?꾩껜 ?숆린??
  if (path === '/api/sheets/sync' && method === 'POST') {
    const apiKey = await getGoogleApiKey();
    if (!apiKey) return json({ error: 'Google API ??誘몄꽕?? /api/sheets/config ?먯꽌 ?ㅼ젙?섏꽭??' }, 400);

    const body = await request.json().catch(() => ({}));
    const targetSheet = body.sheet; // ?뱀젙 ?쒗듃留??숆린??(?놁쑝硫??꾩껜)
    const targetTab = body.tab; // ?뱀젙 ??쭔

    const sheetsToSync = targetSheet ? { [targetSheet]: TBO_SHEETS[targetSheet] } : TBO_SHEETS;
    if (targetSheet && !TBO_SHEETS[targetSheet]) return json({ error: '?????녿뒗 ?쒗듃: ' + targetSheet + '. 媛?? ' + Object.keys(TBO_SHEETS).join(',') }, 400);

    const results = {};
    for (const [key, spreadsheetId] of Object.entries(sheetsToSync)) {
      try {
        // 癒쇱? ?쒗듃 硫뷀??곗씠?곕줈 ??紐⑸줉 媛?몄삤湲?
        const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title&key=${apiKey}`;
        const metaResp = await fetch(metaUrl);
        if (!metaResp.ok) {
          results[key] = { error: `硫뷀??곗씠???ㅽ뙣 (${metaResp.status})`, detail: await metaResp.text() };
          continue;
        }
        const meta = await metaResp.json();
        const tabs = meta.sheets.map(s => s.properties.title);

        const tabsToSync = targetTab ? tabs.filter(t => t === targetTab) : tabs;
        const tabResults = {};
        const MAX_BATCH = 40; // CF Workers ?쒕툕由ы섏뒪???쒗븳(50) ???
        for (let i = 0; i < tabsToSync.length && i < MAX_BATCH; i++) {
          const tab = tabsToSync[i];
          try {
            const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent("'" + tab + "'")}?key=${apiKey}`;
            const dataResp = await fetch(dataUrl);
            if (!dataResp.ok) {
              tabResults[tab] = { error: `?곗씠???ㅽ뙣 (${dataResp.status})` };
              continue;
            }
            const sheetData = await dataResp.json();
            const rows = sheetData.values || [];

            // D1 罹먯떆?????
            await db.prepare(
              "INSERT OR REPLACE INTO sheets_cache (sheet_key, tab_name, data, row_count, synced_at) VALUES (?,?,?,?,unixepoch())"
            ).bind(key, tab, JSON.stringify(rows), rows.length).run();

            tabResults[tab] = { rows: rows.length, synced: true };
          } catch(e) {
            tabResults[tab] = { error: e.message };
          }
        }
        const remaining = tabsToSync.length > MAX_BATCH ? tabsToSync.length - MAX_BATCH : 0;
        results[key] = { tabs: tabResults, total_tabs: tabs.length, synced_count: Object.keys(tabResults).length, remaining };
      } catch(e) {
        results[key] = { error: e.message };
      }
    }

    return json({ success: true, results });
  }

  // GET /api/sheets/data ??罹먯떆???쒗듃 ?곗씠??議고쉶
  if (path === '/api/sheets/data' && method === 'GET') {
    const sheetKey = url.searchParams.get('sheet');
    const tab = url.searchParams.get('tab');
    const summary = url.searchParams.get('summary') === 'true';

    if (!sheetKey) {
      // ?꾩껜 罹먯떆 紐⑸줉 諛섑솚
      const all = await db.prepare("SELECT sheet_key, tab_name, row_count, synced_at FROM sheets_cache ORDER BY sheet_key, tab_name").all();
      return json({ success: true, cache: all.results });
    }

    let q = "SELECT * FROM sheets_cache WHERE sheet_key=?";
    const params = [sheetKey];
    if (tab) { q += " AND tab_name=?"; params.push(tab); }

    const rows = await db.prepare(q).bind(...params).all();
    if (!rows.results.length) return json({ error: '罹먯떆 ?놁쓬. /api/sheets/sync 濡??숆린?뷀븯?몄슂.' }, 404);

    if (summary) {
      // ?붿빟 紐⑤뱶: ?ㅻ뜑 + ???섎쭔
      const summaryData = rows.results.map(r => {
        const parsed = JSON.parse(r.data);
        return {
          sheet_key: r.sheet_key,
          tab_name: r.tab_name,
          headers: parsed[0] || [],
          row_count: r.row_count,
          synced_at: r.synced_at
        };
      });
      return json({ success: true, data: summaryData });
    }

    // ?꾩껜 ?곗씠??
    const result = rows.results.map(r => ({
      sheet_key: r.sheet_key,
      tab_name: r.tab_name,
      data: JSON.parse(r.data),
      row_count: r.row_count,
      synced_at: r.synced_at
    }));
    return json({ success: true, data: result });
  }

  // GET /api/sheets/overview ???꾨줈?뺤뀡 ?꾩껜 ?꾪솴 ?붿빟 (??쒕낫?쒖슜)
  if (path === '/api/sheets/overview' && method === 'GET') {
    const allCache = await db.prepare("SELECT sheet_key, tab_name, data, row_count, synced_at FROM sheets_cache").all();
    if (!allCache.results.length) return json({ error: '罹먯떆 ?놁쓬. 癒쇱? /api/sheets/sync 濡??숆린?뷀븯?몄슂.' }, 404);

    const overview = {};
    let lastSync = 0;
    for (const row of allCache.results) {
      if (!overview[row.sheet_key]) overview[row.sheet_key] = { tabs: [], total_rows: 0 };
      overview[row.sheet_key].tabs.push({ name: row.tab_name, rows: row.row_count });
      overview[row.sheet_key].total_rows += row.row_count;
      if (row.synced_at > lastSync) lastSync = row.synced_at;
    }

    return json({
      success: true,
      overview,
      sheets_count: Object.keys(overview).length,
      total_tabs: allCache.results.length,
      last_sync: lastSync
    });
  }


  // POST /api/sheets/write - queue first, then write directly through Google Sheets API v4 when configured.
  if (path === '/api/sheets/write' && method === 'POST') {
    const user = await authenticateAny(request, env);
    const role = String(user?.role || '').toLowerCase();
    if (!user || !['admin', 'pd', 'producer'].includes(role)) {
      return json({ error: 'Admin/PD only' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const sheetKey = String(body.sheet || body.sheet_key || '').trim();
    const tabName = String(body.tab || body.tab_name || '').trim();
    const mode = String(body.mode || 'append').trim();
    const range = String(body.range || body.a1 || '').trim();
    const values = normalizeSheetValues(body);
    if (!sheetKey || !tabName || !TBO_SHEETS[sheetKey]) {
      return json({ error: 'Invalid sheet or tab', sheets: Object.keys(TBO_SHEETS) }, 400);
    }
    if (!['append', 'update'].includes(mode)) {
      return json({ error: 'Unsupported write mode' }, 400);
    }
    if (mode === 'update' && !range) {
      return json({ error: 'range is required for update mode' }, 400);
    }
    if (!values.length) {
      return json({ error: 'values or value is required' }, 400);
    }
    const policyError = validateSheetWritePolicy({ sheetKey, tabName, mode, range });
    if (policyError) {
      return json({ error: 'Write policy violation', detail: policyError }, 400);
    }

    const id = 'swq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const payload = {
      sheet: sheetKey,
      tab: tabName,
      mode,
      range,
      values,
      row: body.row,
      col: body.col,
      value: body.value,
      item: body.item || null,
      requested_by: user.email || user.name || user.id || 'unknown'
    };

    await db.prepare(
      `INSERT INTO sheet_write_queue (id, sheet_key, tab_name, mode, payload, created_by)
      VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, sheetKey, tabName, mode, JSON.stringify(payload), payload.requested_by).run();

    try {
      const result = await writeGoogleSheetDirect(env, {
        sheetKey,
        tabName,
        mode,
        range,
        values,
      });
      if (result.queued) {
        await db.prepare(
          `UPDATE sheet_write_queue SET status='pending', attempts=attempts+1, error=?, updated_at=unixepoch() WHERE id=?`
        ).bind(result.reason, id).run();
        return json({ success: true, id, status: 'queued', reason: result.reason }, 202);
      }

      await db.prepare(
        `UPDATE sheet_write_queue SET status='synced', attempts=attempts+1, error=NULL, updated_at=unixepoch()
         WHERE id=?`
      ).bind(id).run();
      await db.prepare(
        `INSERT OR REPLACE INTO sheets_cache (sheet_key, tab_name, data, row_count, synced_at)
         VALUES (?, ?, COALESCE((SELECT data FROM sheets_cache WHERE sheet_key=? AND tab_name=?), '[]'),
                 COALESCE((SELECT row_count FROM sheets_cache WHERE sheet_key=? AND tab_name=?), 0), unixepoch())`
      ).bind(sheetKey, tabName, sheetKey, tabName, sheetKey, tabName).run();
      return json({ success: true, id, status: 'synced', provider: 'google_sheets_api_v4', writeback: result });
    } catch (e) {
      await db.prepare(
        `UPDATE sheet_write_queue SET status='pending', attempts=attempts+1, error=?, updated_at=unixepoch()
         WHERE id=?`
      ).bind(e.message || String(e), id).run();
      return json({ success: true, id, status: 'queued', error: e.message || String(e) }, 202);
    }
  }

  // GET /api/sheets/write-queue - inspect queued/synced writeback requests.
  if (path === '/api/sheets/write-queue' && method === 'GET') {
    const user = await authenticateAny(request, env);
    const role = String(user?.role || '').toLowerCase();
    if (!user || !['admin', 'pd', 'producer'].includes(role)) {
      return json({ error: 'Admin/PD only' }, 403);
    }
    const status = url.searchParams.get('status') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    let sql = 'SELECT * FROM sheet_write_queue';
    const params = [];
    if (status) {
      sql += ' WHERE status=?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const rows = await db.prepare(sql).bind(...params).all();
    return json({ success: true, writes: rows.results || [] });
  }

  return json({ error: 'Sheets API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// ===================================================================
// Seedance 2.0 AI ?뚮뜑留?API (Maya Playblast ??AI Video)
// BytePlus ModelArk API + D1 ?묒뾽 異붿쟻 + R2 寃곌낵 ???// ===================================================================

async function initSeedanceTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS seedance_jobs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    session_id TEXT,
    cut_id TEXT,
    shot_id TEXT,
    mode TEXT DEFAULT 'omni_reference',
    model TEXT DEFAULT 'seedance-2',
    prompt TEXT,
    source_url TEXT,
    ref_image_urls TEXT,
    duration INTEGER DEFAULT 5,
    aspect_ratio TEXT DEFAULT '16:9',
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    result_url TEXT,
    r2_key TEXT,
    cost REAL DEFAULT 0,
    error TEXT,
    created_by TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS seedance_character_sheets (
    folder TEXT PRIMARY KEY,
    asset_type TEXT NOT NULL,
    asset_code TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    tags TEXT,
    notes TEXT,
    files_json TEXT DEFAULT '[]',
    cover_url TEXT,
    use_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`).run();
}

async function initSeedancePipelineAssets(db) {
  const columns = [
    ['category', 'TEXT'],
    ['storage_mode', "TEXT DEFAULT 'r2'"],
    ['file_key', 'TEXT'],
    ['thumbnail_key', 'TEXT'],
    ['thumbnail_r2_key', 'TEXT'],
    ['mime_type', 'TEXT'],
    ['ext', 'TEXT'],
    ['ai_source', 'TEXT'],
    ['ai_model', 'TEXT'],
    ['ai_prompt', 'TEXT'],
    ['archived', 'INTEGER DEFAULT 0'],
    ['archived_at', 'INTEGER'],
    ['archived_by', 'TEXT'],
    ['created_at', 'INTEGER DEFAULT (unixepoch())'],
    ['updated_at', 'INTEGER DEFAULT (unixepoch())']
  ];
  let existingColumns = null;
  try {
    const info = await db.prepare('PRAGMA table_info(assets)').all();
    existingColumns = new Set((info.results || []).map(row => String(row.name || '').toLowerCase()));
  } catch (_) {
    existingColumns = null;
  }
  for (const [name, definition] of columns) {
    if (existingColumns && existingColumns.has(name.toLowerCase())) continue;
    try {
      await db.prepare(`ALTER TABLE assets ADD COLUMN ${name} ${definition}`).run();
    } catch (err) {
      if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
    }
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_assets_seedance_pipeline ON assets(project_id, category, type, archived, created_at)").run();
}

async function handleSeedanceAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;
  await initSeedanceTables(db);
  await initSeedancePipelineAssets(db);

  // BytePlus ModelArk API
  const BYTEPLUS_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

  // API ??議고쉶: Worker Secret ?꾩슜
  async function getBytePlusKey() {
    return env.BYTEPLUS_API_KEY || null;
  }

  // BytePlus API 怨듯넻 ?ㅻ뜑
  function byteHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    };
  }

  function normalizeSeedanceDuration(value, fallback = 5) {
    const n = parseInt(value || fallback, 10);
    return Math.min(15, Math.max(4, Number.isFinite(n) ? n : fallback));
  }

  function resolveSeedanceRatio(aspectRatio, refs = []) {
    if (aspectRatio && aspectRatio !== 'adaptive' && aspectRatio !== 'auto') return aspectRatio;
    const first = Array.isArray(refs) ? refs.find(ref => ref && (ref.width || ref.height || ref.aspect_ratio || ref.ratio)) : null;
    if (first?.aspect_ratio || first?.ratio) return first.aspect_ratio || first.ratio;
    if (first?.width && first?.height) {
      const w = Number(first.width);
      const h = Number(first.height);
      if (w > 0 && h > 0) {
        const r = w / h;
        if (r > 2) return '21:9';
        if (r > 1.45) return '16:9';
        if (r > 1.15) return '4:3';
        if (r > 0.85) return '1:1';
        if (r > 0.65) return '3:4';
        return '9:16';
      }
    }
    return '16:9';
  }

  function buildSeedanceContent({ prompt, references, ref_image_urls, source_url, mode, video_urls }) {
    const content = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    if (Array.isArray(references) && references.length) {
      for (const ref of references.slice(0, 15)) {
        if (!ref?.url) continue;
        const refKind = String(ref.type || ref.role || '').toLowerCase();
        const refUrl = String(ref.url || '');
        const isAudioRef = refKind.includes('audio') || /\.(mp3|wav|m4a|aac|ogg)(\?|$)/i.test(refUrl);
        const isVideoRef = refKind.includes('video') || refKind.includes('playblast') || refKind.includes('storyboard') || refKind.includes('guide') || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(refUrl);
        const refType = isAudioRef ? 'audio_url' : isVideoRef ? 'video_url' : 'image_url';
        const defaultRole = refType === 'audio_url' ? 'reference_audio' : refType === 'video_url' ? 'reference_video' : 'reference_image';
        content.push({ type: refType, [refType]: { url: refUrl }, role: ref.role || defaultRole });
      }
    }
    if (Array.isArray(video_urls) && video_urls.length) {
      for (const videoUrl of video_urls.slice(0, 8)) {
        const url = typeof videoUrl === 'string' ? videoUrl : videoUrl.url;
        if (url) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
      }
    }
    if (ref_image_urls && ref_image_urls.length) {
      for (const imgUrl of ref_image_urls.slice(0, 15)) {
        content.push({ type: 'image_url', image_url: { url: imgUrl }, role: 'reference_image' });
      }
    }
    if (source_url) {
      const isVideoMode = mode === 'omni_reference' || mode === 'extend_video' || mode === 'stitch_video';
      if (isVideoMode) content.push({ type: 'video_url', video_url: { url: source_url }, role: 'reference_video' });
      else content.push({ type: 'image_url', image_url: { url: source_url }, role: 'reference_image' });
    }
    return content;
  }

  function normalizeSeedanceAssetType(value) {
    const type = String(value || 'CH').toUpperCase();
    return ['CH', 'PROP', 'MECH'].includes(type) ? type : 'CH';
  }

  function normalizeSeedanceAssetCode(value) {
    const raw = String(value || '001').trim().replace(/[^A-Za-z0-9_-]+/g, '');
    const withoutType = raw.replace(/^(CH|PROP|MECH)/i, '');
    return (withoutType || '001').toUpperCase().slice(0, 24);
  }

  function normalizeSeedanceAssetName(value) {
    return (String(value || 'Unnamed').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Unnamed').slice(0, 64);
  }

  function normalizeReferenceRole(value) {
    const role = String(value || 'body').toLowerCase();
    return ['body', 'face', 'turnaround', 'prop', 'mech', 'other'].includes(role) ? role : 'other';
  }

  function characterFileToPublic(file) {
    return { ...file, url: `/api/seedance/charimg/${encodeURIComponent(file.key)}` };
  }

  function parseCharacterFiles(value) {
    try {
      const files = JSON.parse(value || '[]');
      return Array.isArray(files) ? files.map(characterFileToPublic) : [];
    } catch {
      return [];
    }
  }

  const PIPELINE_ASSET_CATEGORIES = new Set(['character', 'background', 'playblast', 'firstframe']);

  function normalizePipelineCategory(value) {
    const category = String(value || '').trim().toLowerCase();
    return PIPELINE_ASSET_CATEGORIES.has(category) ? category : '';
  }

  function normalizePipelineProjectId(value) {
    return String(value || 'tbo').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'tbo';
  }

  function normalizePipelineAssetName(value, fallback) {
    return (String(value || fallback || 'pipeline_asset').trim().replace(/[<>:"\\|?*\u0000-\u001F]+/g, '_').replace(/\s+/g, ' ') || 'pipeline_asset').slice(0, 160);
  }

  function normalizePipelineExt(name, mimeType) {
    const fromName = String(name || '').split('.').pop()?.toLowerCase() || '';
    const allowed = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm'];
    if (allowed.includes(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName;
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'video/mp4') return 'mp4';
    if (mimeType === 'video/quicktime') return 'mov';
    if (mimeType === 'video/webm') return 'webm';
    return 'bin';
  }

  function isAllowedPipelineUpload(category, mimeType, ext) {
    if (category === 'playblast') return /^video\//.test(mimeType) || ['mp4', 'mov', 'webm'].includes(ext);
    return /^image\//.test(mimeType) || ['jpg', 'png', 'webp', 'gif'].includes(ext);
  }

  function nextPipelineVersion(value) {
    const match = String(value || 'v00').match(/^v(\d+)$/i);
    const n = match ? parseInt(match[1], 10) + 1 : 1;
    return 'v' + String(Math.max(1, n)).padStart(2, '0');
  }

  function pipelineAssetToPublic(row) {
    const fileKey = row.file_key || '';
    const thumbKey = row.thumbnail_key || row.thumbnail_r2_key || '';
    return {
      id: row.id,
      project_id: row.project_id,
      category: row.category,
      type: row.type,
      name: row.name,
      status: row.status,
      version: row.version || 'v01',
      storage_mode: row.storage_mode || 'r2',
      file_key: fileKey,
      thumbnail_key: thumbKey,
      mime_type: row.mime_type || '',
      ext: row.ext || '',
      ai_source: row.ai_source || '',
      ai_model: row.ai_model || '',
      ai_prompt: row.ai_prompt || '',
      url: fileKey ? `/api/seedance/pipeline/file/${encodeURIComponent(row.id)}` : '',
      thumbnail_url: thumbKey ? `/api/seedance/pipeline/file/${encodeURIComponent(row.id)}?kind=thumb` : '',
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  function characterRowToPublic(row) {
    const files = parseCharacterFiles(row.files_json);
    return {
      folder: row.folder,
      key: row.folder,
      prefix: `CharacterSheets/${row.folder}/`,
      id: row.asset_type + row.asset_code,
      type: row.asset_type,
      asset_type: row.asset_type,
      number: row.asset_code,
      asset_code: row.asset_code,
      name: row.asset_name,
      asset_name: row.asset_name,
      tags: row.tags || '',
      notes: row.notes || '',
      file_count: files.length,
      files_count: files.length,
      cover_url: row.cover_url || files[0]?.url || '',
      use_count: row.use_count || 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async function requireSeedanceAdmin() {
    const user = await authenticateAny(request, env);
    if (!user) return { error: json({ error: 'Unauthorized' }, 401) };
    if (!['admin', 'pd', 'producer', 'director'].includes(String(user.role || '').toLowerCase())) {
      return { error: json({ error: 'Admin/PD only' }, 403) };
    }
    return { user };
  }

  // GET/POST /api/seedance/projects - project picker/create for Seedance pipeline UI.
  if (path === '/api/seedance/projects' && method === 'POST') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const name = normalizePipelineAssetName(body.name, 'New Seedance Project');
    const code = String(body.code || name).trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 32).toUpperCase() || 'SEEDANCE';
    const id = normalizePipelineProjectId(body.id || code.toLowerCase());
    const now = Math.floor(Date.now() / 1000);
    const existing = await db.prepare('SELECT id FROM projects WHERE id=?').bind(id).first();
    if (existing) return json({ error: 'Project already exists', id }, 409);
    await db.prepare(`
      INSERT INTO projects (id, name, client, status, project_type, description, thumbnail_url, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 'seedance_pipeline', ?, ?, ?, ?, ?)
    `).bind(
      id,
      name,
      String(body.client || 'STUDIOJUN').slice(0, 120),
      String(body.description || 'Seedance 2.0 pipeline project').slice(0, 1000),
      String(body.thumbnail_url || '').slice(0, 500),
      auth.user.email || auth.user.name || auth.user.id || 'seedance-admin',
      now,
      now
    ).run();
    return json({ success: true, project: { id, name, code, thumbnail_url: body.thumbnail_url || '' } }, 201);
  }

  if (path === '/api/seedance/projects' && method === 'GET') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    let rows = [];
    try {
      const result = await db.prepare('SELECT * FROM projects WHERE COALESCE(archived, 0)=0 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 100').all();
      rows = result.results || [];
    } catch (_) {
      try {
        const result = await db.prepare("SELECT DISTINCT project_id as id FROM assets WHERE project_id IS NOT NULL AND project_id != '' ORDER BY project_id LIMIT 100").all();
        rows = result.results || [];
      } catch (__) {
        rows = [];
      }
    }
    if (!rows.length) rows = [{ id: 'tbo', code: 'TBO', name: 'TURBO ONE' }];
    const projects = rows.map(row => {
      const id = String(row.id || row.project_id || row.code || 'tbo');
      return {
        id,
        name: row.name || row.title || row.project_name || row.code || id,
        code: row.code || row.project_code || id,
        thumbnail_url: row.thumbnail_url || row.thumbnail || row.thumbnail_r2_key ? (row.thumbnail_url || row.thumbnail || `/r2/download/${row.thumbnail_r2_key}`) : ''
      };
    });
    return json({ success: true, projects });
  }

  // GET /api/seedance/pipeline/file/:id - safe R2 proxy for pipeline asset originals/thumbs.
  const pipelineFileMatch = path.match(/^\/api\/seedance\/pipeline\/file\/([^/]+)$/);
  if (pipelineFileMatch && method === 'GET') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    if (!env.ASSETS) return json({ error: 'R2 ASSETS binding missing' }, 500);
    const url = new URL(request.url);
    const assetId = decodeURIComponent(pipelineFileMatch[1]);
    const kind = url.searchParams.get('kind') === 'thumb' ? 'thumb' : 'original';
    const row = await db.prepare("SELECT * FROM assets WHERE id=? AND type='pipeline' AND COALESCE(archived, 0)=0").bind(assetId).first();
    if (!row) return json({ error: 'Pipeline asset not found' }, 404);
    const key = kind === 'thumb' ? (row.thumbnail_key || row.thumbnail_r2_key || row.file_key) : row.file_key;
    if (!key) return json({ error: 'Pipeline asset has no R2 key' }, 404);
    const object = await env.ASSETS.get(key);
    if (!object) return json({ error: 'R2 object not found', key }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(object.body, { status: 200, headers });
  }

  // GET /api/seedance/pipeline/assets?project_id=&category=
  if (path === '/api/seedance/pipeline/assets' && method === 'GET') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    const url = new URL(request.url);
    const projectId = normalizePipelineProjectId(url.searchParams.get('project_id'));
    const category = normalizePipelineCategory(url.searchParams.get('category'));
    if (!category) return json({ error: 'category must be one of character, background, playblast, firstframe' }, 400);
    const rows = await db.prepare(`
      SELECT * FROM assets
      WHERE project_id=? AND category=? AND type='pipeline' AND COALESCE(archived, 0)=0
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 500
    `).bind(projectId, category).all();
    return json({ success: true, assets: (rows.results || []).map(pipelineAssetToPublic) });
  }

  // POST /api/seedance/pipeline/assets - upload project-specific pipeline asset to R2 and assets.
  if (path === '/api/seedance/pipeline/assets' && method === 'POST') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    if (!env.ASSETS) return json({ error: 'R2 ASSETS binding missing' }, 500);
    const formData = await request.formData();
    const projectId = normalizePipelineProjectId(formData.get('project_id'));
    const category = normalizePipelineCategory(formData.get('category'));
    if (!category) return json({ error: 'category must be one of character, background, playblast, firstframe' }, 400);
    const file = formData.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'file is required' }, 400);
    const mimeType = file.type || 'application/octet-stream';
    const ext = normalizePipelineExt(file.name, mimeType);
    if (!isAllowedPipelineUpload(category, mimeType, ext)) {
      return json({ error: category === 'playblast' ? 'playblast requires a video file' : `${category} requires an image file` }, 400);
    }
    const assetId = 'pipe_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
    const fileKey = `pipeline/${projectId}/${category}/${assetId}.${ext}`;
    const fileBody = await file.arrayBuffer();
    await env.ASSETS.put(fileKey, fileBody, { httpMetadata: { contentType: mimeType } });
    const thumbnailKey = mimeType.startsWith('image/') ? fileKey : '';
    const now = Math.floor(Date.now() / 1000);
    const actor = auth.user.email || auth.user.name || auth.user.id || 'seedance-admin';
    const name = normalizePipelineAssetName(formData.get('name'), file.name);
    await db.prepare(`
      INSERT INTO assets
        (id, project_id, category, type, storage_mode, file_key, thumbnail_key, thumbnail_r2_key, mime_type, ext, version, name, status, archived, created_at, updated_at, assignee, note)
      VALUES
        (?, ?, ?, 'pipeline', 'r2', ?, ?, ?, ?, ?, 'v01', ?, 'ready', 0, ?, ?, ?, ?)
    `).bind(assetId, projectId, category, fileKey, thumbnailKey, thumbnailKey, mimeType, ext, name, now, now, actor, 'Seedance pipeline asset').run();
    const row = await db.prepare('SELECT * FROM assets WHERE id=?').bind(assetId).first();
    return json({ success: true, asset: pipelineAssetToPublic(row) }, 201);
  }

  // POST /api/seedance/pipeline/assets/:id/replace - replace R2 file, keep asset id, bump version.
  const pipelineReplaceMatch = path.match(/^\/api\/seedance\/pipeline\/assets\/([^/]+)\/replace$/);
  if (pipelineReplaceMatch && method === 'POST') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    if (!env.ASSETS) return json({ error: 'R2 ASSETS binding missing' }, 500);
    const assetId = decodeURIComponent(pipelineReplaceMatch[1]);
    const existing = await db.prepare("SELECT * FROM assets WHERE id=? AND type='pipeline' AND COALESCE(archived, 0)=0").bind(assetId).first();
    if (!existing) return json({ error: 'Pipeline asset not found' }, 404);
    const category = normalizePipelineCategory(existing.category);
    if (!category) return json({ error: 'Pipeline asset category is invalid' }, 400);
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'file is required' }, 400);
    const mimeType = file.type || 'application/octet-stream';
    const ext = normalizePipelineExt(file.name, mimeType);
    if (!isAllowedPipelineUpload(category, mimeType, ext)) {
      return json({ error: category === 'playblast' ? 'playblast requires a video file' : `${category} requires an image file` }, 400);
    }
    const projectId = normalizePipelineProjectId(existing.project_id);
    const fileKey = `pipeline/${projectId}/${category}/${assetId}.${ext}`;
    const fileBody = await file.arrayBuffer();
    await env.ASSETS.put(fileKey, fileBody, { httpMetadata: { contentType: mimeType } });
    const thumbnailKey = mimeType.startsWith('image/') ? fileKey : '';
    const now = Math.floor(Date.now() / 1000);
    const version = nextPipelineVersion(existing.version);
    await db.prepare(`
      UPDATE assets
      SET file_key=?, thumbnail_key=?, thumbnail_r2_key=?, mime_type=?, ext=?, version=?, storage_mode='r2', status='ready', updated_at=?
      WHERE id=?
    `).bind(fileKey, thumbnailKey, thumbnailKey, mimeType, ext, version, now, assetId).run();
    const row = await db.prepare('SELECT * FROM assets WHERE id=?').bind(assetId).first();
    return json({ success: true, asset: pipelineAssetToPublic(row) });
  }

  // DELETE /api/seedance/pipeline/assets/:id - soft delete only; R2 original is preserved.
  const pipelineDeleteMatch = path.match(/^\/api\/seedance\/pipeline\/assets\/([^/]+)$/);
  if (pipelineDeleteMatch && method === 'DELETE') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    const assetId = decodeURIComponent(pipelineDeleteMatch[1]);
    const existing = await db.prepare("SELECT * FROM assets WHERE id=? AND type='pipeline' AND COALESCE(archived, 0)=0").bind(assetId).first();
    if (!existing) return json({ error: 'Pipeline asset not found' }, 404);
    const now = Math.floor(Date.now() / 1000);
    const actor = auth.user.email || auth.user.name || auth.user.id || 'seedance-admin';
    await db.prepare("UPDATE assets SET archived=1, archived_at=?, archived_by=?, updated_at=? WHERE id=?").bind(now, actor, now, assetId).run();
    return json({ success: true, id: assetId, archived: true, preserved_r2_key: existing.file_key || '' });
  }

  function normalizeCell(value) {
    return String(value ?? '').trim();
  }

  function rowMatchesShot(rowObject, needle) {
    if (!needle) return false;
    const haystack = Object.values(rowObject).map(normalizeCell).join(' ').toLowerCase();
    return haystack.includes(String(needle).toLowerCase());
  }

  function sheetRowsToObjects(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const headers = rows[0].map((h, i) => normalizeCell(h) || `col_${i + 1}`);
    return rows.slice(1).map((row, rowIndex) => {
      const obj = { _row: rowIndex + 2 };
      headers.forEach((h, i) => { obj[h] = normalizeCell(row[i]); });
      return obj;
    });
  }

  function classifyBreakdownRow(rowObject) {
    const keys = Object.keys(rowObject).join(' ').toLowerCase();
    const text = Object.values(rowObject).join(' ').toLowerCase();
    const isChar = /character|char|ch_/i.test(keys + text);
    const isProp = /prop/i.test(keys + text);
    const isEnv = /environment|env|background/i.test(keys + text);
    const isPlayblast = /playblast|animatic|maya|\.mp4|\.mov/i.test(text);
    const isGuide = /guide|direction|director|comment|note/i.test(keys + text);
    return { isChar, isProp, isEnv, isPlayblast, isGuide };
  }

  async function findR2ReferencesForShot(shotCode, sheetRows) {
    if (!env.ASSETS) return [];
    const tokens = new Set();
    if (shotCode) {
      tokens.add(String(shotCode).toLowerCase());
      String(shotCode).split(/[_\-\s]+/).filter(Boolean).forEach(t => tokens.add(t.toLowerCase()));
    }
    for (const row of sheetRows.slice(0, 20)) {
      for (const value of Object.values(row)) {
        const v = normalizeCell(value);
        if (v && v.length >= 3 && v.length <= 80) tokens.add(v.toLowerCase());
      }
    }
    const prefixes = ['CharacterSheets/', 'reference-image/', 'playblast/', 'guide-videos/', 'storyboard/', 'reference/', 'Assets/'];
    const refs = [];
    for (const prefix of prefixes) {
      try {
        const listing = await env.ASSETS.list({ prefix, limit: 200 });
        for (const obj of (listing.objects || [])) {
          const keyLower = obj.key.toLowerCase();
          const matched = Array.from(tokens).some(t => t && keyLower.includes(t));
          if (!matched) continue;
          const ext = keyLower.split('.').pop() || '';
          const type = ['mp4', 'mov', 'webm'].includes(ext) ? 'video'
            : ['mp3', 'wav', 'm4a'].includes(ext) ? 'audio'
            : ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image'
            : 'file';
          refs.push({
            key: obj.key,
            url: `https://studiojun.co.kr/r2/${encodeURIComponent(obj.key).replace(/%2F/g, '/')}`,
            type,
            size: obj.size || 0,
            role: type === 'video' ? (keyLower.includes('guide') ? 'direction_guide' : 'playblast') : 'reference_image'
          });
        }
      } catch (e) {}
    }
    return refs.slice(0, 24);
  }

  async function buildShotAutomationContext({ shot_code, cut_id }) {
    let shotCode = shot_code || '';
    let cutInfo = null;
    if (cut_id) {
      cutInfo = await db.prepare(
        `SELECT c.id, c.description, c.duration, c.cut_number, c.shot_id, e.id as episode_id, e.title as ep_title
         FROM sb_cuts c LEFT JOIN sb_episodes e ON c.episode_id = e.id WHERE c.id = ?`
      ).bind(cut_id).first();
      if (!shotCode && cutInfo?.shot_id) shotCode = cutInfo.shot_id;
    }
    let shotInfo = null;
    if (shotCode) {
      shotInfo = await db.prepare('SELECT * FROM shots WHERE shot_code = ? OR id = ? LIMIT 1').bind(shotCode, shotCode).first().catch(() => null);
    }

    const allCache = await db.prepare("SELECT sheet_key, tab_name, data, row_count, synced_at FROM sheets_cache").all().catch(() => ({ results: [] }));
    const matchedRows = [];
    const sheetSummary = [];
    for (const cache of (allCache.results || [])) {
      let rows = [];
      try { rows = JSON.parse(cache.data || '[]'); } catch (e) { rows = []; }
      const objects = sheetRowsToObjects(rows);
      const matches = objects.filter(row => rowMatchesShot(row, shotCode || cut_id));
      if (matches.length) {
        sheetSummary.push({ sheet_key: cache.sheet_key, tab_name: cache.tab_name, matches: matches.length, synced_at: cache.synced_at });
        matches.slice(0, 12).forEach(row => matchedRows.push({ sheet_key: cache.sheet_key, tab_name: cache.tab_name, ...row, _class: classifyBreakdownRow(row) }));
      }
    }

    const references = await findR2ReferencesForShot(shotCode, matchedRows);
    const categorized = {
      character_sheets: matchedRows.filter(r => r._class?.isChar).slice(0, 12),
      prop_sheets: matchedRows.filter(r => r._class?.isProp).slice(0, 12),
      background_sheets: matchedRows.filter(r => r._class?.isEnv).slice(0, 12),
      playblasts: references.filter(r => r.type === 'video' && r.role === 'playblast'),
      direction_guides: matchedRows.filter(r => r._class?.isGuide).slice(0, 12).concat(references.filter(r => r.role === 'direction_guide')),
      r2_references: references,
    };
    return { shot_code: shotCode, cut_id: cut_id || '', cut: cutInfo, shot: shotInfo, sheets: sheetSummary, breakdown_rows: matchedRows.slice(0, 60), ...categorized };
  }

  async function generateShotSeedancePrompt(context, options = {}) {
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY 誘몄꽕?');
    const system = `You are Claude Code API acting as a senior Seedance 2.0 prompt engineer for STUDIOJUN's 3D animation pipeline.
Use Google Sheets shot breakdown data, character sheets, prop sheets, background sheets, Maya playblast, and direction guides.
Write a production-ready English Seedance 2.0 prompt for Turbo One.
Preserve shot IDs, asset names, character names, file names, and frame numbers.
Prioritize animation terminology: timing, spacing, arcs, anticipation, follow-through, silhouette, camera, lighting, FX, rendering, compositing.
Return ONLY valid JSON.`;
    const userMessage = `<shot_context>${JSON.stringify(context, null, 2)}</shot_context>
<constraints>
- Output JSON with keys: prompt, negative_prompt, params, references, notes_ko.
- prompt must be English and under 220 words.
- params.mode should prefer "omni_reference" when a playblast exists, otherwise "text_to_video".
- params.aspect_ratio should be "adaptive" unless the sheet states a ratio.
- params.duration should be 4-15 seconds.
- references should include URLs for character/prop/background/playblast/guide when available.
- notes_ko should explain which sheet/R2 sources were used.
</constraints>
<options>${JSON.stringify(options)}</options>`;
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const aiData = await aiResp.json();
    const raw = aiData.content?.[0]?.text || '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (e) {
      parsed = { prompt: raw.trim(), negative_prompt: '', params: {}, references: [], notes_ko: 'JSON ?뚯떛 ?ㅽ뙣. ?먮Ц ?꾨＼?꾪듃瑜??ъ슜?덉뒿?덈떎.' };
    }
    if (!parsed.prompt) throw new Error('Claude prompt empty');
    return parsed;
  }

  // POST /api/seedance/config ??API ?????(D1 fallback??
  if (path === '/api/seedance/config' && method === 'POST') {
    return json({ error: 'BytePlus API key must be configured as Worker Secret BYTEPLUS_API_KEY. D1 app_config storage is disabled.' }, 410);
  }

  // GET /api/seedance/config ????議댁옱 ?щ? 諛섑솚
  if (path === '/api/seedance/config' && method === 'GET') {
    const key = await getBytePlusKey();
    return json({
      configured: !!key,
      provider: 'byteplus_modelark',
      masked: key ? '****' + key.slice(-4) : null
    });
  }

  // POST /api/seedance/render ???뚮뜑 ?묒뾽 ?앹꽦
  if (path === '/api/seedance/render' && method === 'POST') {
    const apiKey = await getBytePlusKey();
    if (!apiKey) return json({ error: 'BytePlus API ?ㅺ? ?ㅼ젙?섏? ?딆븯?듬땲?? /api/seedance/config ?먯꽌 ?ㅼ젙?섍굅??BYTEPLUS_API_KEY secret??異붽??섏꽭??' }, 400);

    const body = await request.json();
    const { prompt, mode, source_url, ref_image_urls, references, duration, aspect_ratio, quality, model, shot_id, cut_id, session_id, created_by, generate_audio, watermark, camera_fixed, seed } = body;
    if (!prompt && !source_url && (!ref_image_urls || !ref_image_urls.length) && (!references || !references.length)) {
      return json({ error: 'prompt ?먮뒗 ?대?吏/?곸긽/?ㅻ뵒???덊띁?곗뒪 URL ?꾩닔' }, 400);
    }

    // 紐⑤뜽紐?留ㅽ븨 (?꾨줎?몄뿏???⑥텞紐???BytePlus ?ㅼ젣 紐⑤뜽 ID)
    const MODEL_MAP = {
      'seedance-2-0': 'dreamina-seedance-2-0-260128',
      'seedance-2-0-fast': 'dreamina-seedance-2-0-fast-260128',
      'standard': 'dreamina-seedance-2-0-260128',
      'fast': 'dreamina-seedance-2-0-fast-260128'
    };
    const taskModel = MODEL_MAP[model] || model || 'dreamina-seedance-2-0-260128';
    const taskDuration = normalizeSeedanceDuration(duration);
    const ratioRefs = Array.isArray(references) && references.length ? references : [];
    const taskAspect = resolveSeedanceRatio(aspect_ratio, ratioRefs);
    const taskMode = mode || (source_url || (ref_image_urls && ref_image_urls.length) ? 'image_to_video' : 'text_to_video');

    // BytePlus 怨듭떇 ModelArk tasks API ?뺤떇:
    // content?먮뒗 ?낅젰 ?띿뒪???덊띁?곗뒪留??ｊ퀬, ratio/duration/watermark/generate_audio??top-level???붾떎.
    const content = buildSeedanceContent({ prompt, references, ref_image_urls, source_url, mode: taskMode });

    const reqBody = {
      model: taskModel,
      content,
      ratio: taskAspect,
      duration: taskDuration,
      generate_audio: generate_audio === true,
      watermark: watermark !== false
    };
    if (quality && ['480p', 'basic', 'high'].includes(quality)) reqBody.quality = quality;
    if (camera_fixed === true) reqBody.camerafixed = true;
    if (typeof seed === 'number' && seed >= 0) reqBody.seed = seed;

    // BytePlus濡??묒뾽 ?꾩넚
    let bpResult;
    try {
      const bpResp = await fetch(BYTEPLUS_BASE + '/contents/generations/tasks', {
        method: 'POST',
        headers: byteHeaders(apiKey),
        body: JSON.stringify(reqBody)
      });
      bpResult = await bpResp.json();
    } catch (e) {
      return json({ error: 'BytePlus API ?붿껌 ?ㅽ뙣: ' + e.message }, 502);
    }

    if (!bpResult.id) {
      return json({ error: 'BytePlus ?묒뾽 ?앹꽦 ?ㅽ뙣', detail: bpResult }, 502);
    }

    // D1???묒뾽 ???
    const jobId = guideId('SEED');
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO seedance_jobs (id, task_id, session_id, cut_id, shot_id, mode, model, prompt, source_url, ref_image_urls, duration, aspect_ratio, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      jobId, bpResult.id, session_id||'', cut_id||'', shot_id||'',
      taskMode, taskModel, prompt||'', source_url||'',
      JSON.stringify(Array.isArray(references) && references.length ? references : (ref_image_urls || [])),
      taskDuration, taskAspect, 'pending', created_by||'director', now, now
    ).run();

    const characterFolders = Array.from(new Set((Array.isArray(references) ? references : [])
      .map(ref => ref && ref.folder)
      .filter(Boolean)));
    for (const folder of characterFolders) {
      await db.prepare(`UPDATE seedance_character_sheets
        SET use_count = COALESCE(use_count, 0) + 1, updated_at = ?
        WHERE folder = ?`).bind(now, folder).run();
    }

    return json({ success: true, job: { id: jobId, task_id: bpResult.id, status: 'pending' } });
  }

  // GET /api/seedance/status/:jobId ???묒뾽 ?곹깭 ?대쭅
  const statusMatch = path.match(/^\/api\/seedance\/status\/([^/]+)$/);
  if (statusMatch && method === 'GET') {
    const job = await db.prepare('SELECT * FROM seedance_jobs WHERE id=?').bind(statusMatch[1]).first();
    if (!job) return json({ error: '?묒뾽 ?놁쓬' }, 404);

    const apiKey = await getBytePlusKey();
    if (!apiKey) return json({ error: 'BytePlus API ??誘몄꽕?' }, 400);

    // BytePlus?먯꽌 理쒖떊 ?곹깭 議고쉶
    let bpStatus;
    try {
      const bpResp = await fetch(BYTEPLUS_BASE + '/contents/generations/tasks/' + job.task_id, {
        headers: byteHeaders(apiKey)
      });
      bpStatus = await bpResp.json();
    } catch (e) {
      return json({ job, byteplus_error: e.message });
    }

    let newStatus = job.status;
    let resultUrl = job.result_url;
    let r2Key = job.r2_key;
    let cost = job.cost;

    // BytePlus ?곹깭媛?留ㅽ븨
    const sMap = { queued:'pending', running:'processing', succeeded:'completed', failed:'failed' };
    if (bpStatus.status) newStatus = sMap[bpStatus.status] || bpStatus.status;

    // ?꾨즺 ??寃곌낵 URL ???
    if (bpStatus.status === 'succeeded') {
      let parsedContent = bpStatus.content;
      if (typeof parsedContent === 'string') {
        try { parsedContent = JSON.parse(parsedContent); } catch(e) { parsedContent = null; }
      }
      if (parsedContent) {
        if (Array.isArray(parsedContent) && parsedContent.length > 0) {
          const vc = parsedContent[0];
          if (typeof vc.video_url === 'string') resultUrl = vc.video_url;
          else if (vc.video_url && vc.video_url.url) resultUrl = vc.video_url.url;
          else if (vc.url) resultUrl = vc.url;
        } else if (typeof parsedContent === 'object') {
          if (typeof parsedContent.video_url === 'string') resultUrl = parsedContent.video_url;
          else if (parsedContent.video_url && parsedContent.video_url.url) resultUrl = parsedContent.video_url.url;
          else if (parsedContent.url) resultUrl = parsedContent.url;
        }
      }
      if (!resultUrl && bpStatus.output) {
        if (typeof bpStatus.output.video_url === 'string') resultUrl = bpStatus.output.video_url;
        else if (bpStatus.output.video_url && bpStatus.output.video_url.url) resultUrl = bpStatus.output.video_url.url;
        else if (bpStatus.output.url) resultUrl = bpStatus.output.url;
      }
      if (!resultUrl && bpStatus.choices && bpStatus.choices.length > 0) {
        const ch = bpStatus.choices[0];
        if (ch.message && ch.message.content && Array.isArray(ch.message.content)) {
          for (const c of ch.message.content) {
            if (c.type === 'video_url' && c.video_url) {
              resultUrl = typeof c.video_url === 'string' ? c.video_url : c.video_url.url || '';
              break;
            }
          }
        }
      }
      if (!r2Key && resultUrl && env.ASSETS) {
        try {
          const vidResp = await fetch(resultUrl);
          if (vidResp.ok) {
            const vidBlob = await vidResp.arrayBuffer();
            r2Key = `seedance/${job.id}.mp4`;
            await env.ASSETS.put(r2Key, vidBlob, { httpMetadata: { contentType: 'video/mp4' } });
          }
        } catch (e) { /* R2 ????ㅽ뙣 臾댁떆 */ }
      }
    }

    // ?ъ슜??異붿텧 諛?鍮꾩슜 怨꾩궛
    if (bpStatus.usage) {
      const u = bpStatus.usage;
      const totalTokens = u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
      const PRICE_PER_M = (job.model || '').includes('fast') ? 3.3 : 4.3;
      cost = Math.round((totalTokens / 1000000) * PRICE_PER_M * 10000) / 10000;
    }

    const errorMsg = bpStatus.status === 'failed' && bpStatus.error ? JSON.stringify(bpStatus.error) : (job.error || '');

    // D1 ?낅뜲?댄듃
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      'UPDATE seedance_jobs SET status=?, result_url=?, r2_key=?, cost=?, error=?, updated_at=? WHERE id=?'
    ).bind(newStatus, resultUrl||'', r2Key||'', cost, errorMsg, now, job.id).run();

    return json({
      success: true,
      job: { ...job, status: newStatus, result_url: resultUrl, r2_key: r2Key, cost },
      byteplus_status: bpStatus.status,
      usage: bpStatus.usage || null
    });
  }

  // GET /api/seedance/jobs ???묒뾽 紐⑸줉
  if (path === '/api/seedance/jobs' && method === 'GET') {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const shotId = url.searchParams.get('shot_id');

    let q = 'SELECT * FROM seedance_jobs';
    let params = [];
    if (shotId) { q += ' WHERE shot_id=?'; params.push(shotId); }
    q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const jobs = await db.prepare(q).bind(...params).all();
    return json({ success: true, jobs: jobs.results });
  }

  // DELETE /api/seedance/jobs/:id ???묒뾽 ??젣
  const delMatch = path.match(/^\/api\/seedance\/jobs\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    const job = await db.prepare('SELECT * FROM seedance_jobs WHERE id=?').bind(delMatch[1]).first();
    if (!job) return json({ error: '?묒뾽 ?놁쓬' }, 404);
    if (job.r2_key && env.ASSETS) {
      try { await env.ASSETS.delete(job.r2_key); } catch(e) {}
    }
    await db.prepare('DELETE FROM seedance_jobs WHERE id=?').bind(delMatch[1]).run();
    return json({ success: true });
  }

  // POST /api/seedance/upload-playblast ??Seedance ?덊띁?곗뒪 ?뚯씪 R2 ?낅줈??
  if (path === '/api/seedance/upload-playblast' && method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('video/') && !contentType.includes('image/') && !contentType.includes('audio/') && !contentType.includes('octet-stream') && !contentType.includes('multipart/form-data')) {
      return json({ error: '?대?吏, 鍮꾨뵒?? ?ㅻ뵒???뚯씪留??낅줈??媛?' }, 400);
    }

    const url = new URL(request.url);
    let fileBody;
    let fileType = contentType;
    let sourceName = url.searchParams.get('filename') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return json({ error: 'file ?꾨뱶媛 ?꾩슂?⑸땲??' }, 400);
      fileBody = await file.arrayBuffer();
      fileType = file.type || 'application/octet-stream';
      sourceName = sourceName || file.name || '';
    } else {
      fileBody = await request.arrayBuffer();
    }
    const uploadType = fileType.includes('image/') ? 'reference-image' : fileType.includes('audio/') ? 'reference-audio' : 'playblast';
    const defaultExt = fileType.includes('image/png') ? 'png' : fileType.includes('image/webp') ? 'webp' : fileType.includes('image/') ? 'jpg' : fileType.includes('audio/mpeg') ? 'mp3' : fileType.includes('audio/wav') ? 'wav' : 'mp4';
    const safeName = sourceName ? sourceName.replace(/[^\w.\-]+/g, '_') : `${uploadType}_${Date.now()}.${defaultExt}`;
    const filename = safeName.includes('.') ? safeName : `${safeName}.${defaultExt}`;
    const r2Key = `${uploadType}/${filename}`;

    await env.ASSETS.put(r2Key, fileBody, {
      httpMetadata: { contentType: fileType.includes('octet-stream') ? (uploadType === 'reference-image' ? 'image/jpeg' : uploadType === 'reference-audio' ? 'audio/mpeg' : 'video/mp4') : fileType }
    });

    const publicUrl = `https://studiojun.co.kr/r2/${r2Key}`;
    return json({ success: true, r2_key: r2Key, url: publicUrl, size: fileBody.byteLength, type: uploadType });
  }

  // GET /api/seedance/usage ???ъ슜???щ젅??吏묎퀎 (seedance_jobs ?먯껜 吏묎퀎 + BytePlus ???곹깭)
  if (path === '/api/seedance/usage' && method === 'GET') {
    await initSeedanceTables(db);

    // seedance_jobs ?먯껜 吏묎퀎
    const stats = await db.prepare(`
      SELECT
        COUNT(*) as total_jobs,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='pending' OR status='processing' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(CAST(cost as REAL)), 0) as total_cost_raw,
        COALESCE(SUM(CASE WHEN status='completed' THEN CAST(cost as REAL) ELSE 0 END), 0) as completed_cost_raw,
        COALESCE(SUM(duration), 0) as total_seconds
      FROM seedance_jobs
    `).first();

    // ???ㅼ젙 ?щ?
    await db.prepare(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()))`).run();
    const bpKey = await getBytePlusKey();
    const configured = !!bpKey;
    const provider = configured ? 'BytePlus/Ark' : null;

    // cost ?뺢퇋??(媛믪씠 ?щ윭硫?洹몃?濡? ?쇳듃硫?/100)
    const rawCost = stats?.total_cost_raw || 0;
    const totalCost = rawCost > 100 ? (rawCost / 100).toFixed(2) : rawCost.toFixed(4);
    const completedCost = stats?.completed_cost_raw || 0;
    const completedCostFmt = completedCost > 100 ? (completedCost / 100).toFixed(2) : completedCost.toFixed(4);

    // 理쒓렐 30???ъ슜??
    const monthly = await db.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(CAST(cost as REAL)),0) as cost
      FROM seedance_jobs
      WHERE created_at >= unixepoch('now', '-30 days') AND status='completed'
    `).first();

    return json({
      success: true,
      configured,
      provider,
      summary: {
        total_jobs: stats?.total_jobs || 0,
        completed: stats?.completed || 0,
        in_progress: stats?.in_progress || 0,
        failed: stats?.failed || 0,
        total_seconds_rendered: stats?.total_seconds || 0,
        total_cost_usd: totalCost,
        completed_cost_usd: completedCostFmt,
      },
      monthly_30d: {
        jobs: monthly?.cnt || 0,
        cost_usd: monthly?.cost > 100 ? (monthly.cost / 100).toFixed(2) : (monthly?.cost || 0).toFixed(4),
      }
    });
  }

  // GET /api/seedance/shot-context ??admin only: Google Sheets breakdown + R2 references
  if (path === '/api/seedance/shot-context' && method === 'GET') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    const url = new URL(request.url);
    const shotCode = url.searchParams.get('shot_code') || url.searchParams.get('shot') || '';
    const cutId = url.searchParams.get('cut_id') || '';
    if (!shotCode && !cutId) return json({ error: 'shot_code or cut_id required' }, 400);
    const context = await buildShotAutomationContext({ shot_code: shotCode, cut_id: cutId });
    return json({ success: true, context });
  }

  // POST /api/seedance/shot-auto-prompt ??admin only: breakdown-aware Claude prompt
  if (path === '/api/seedance/shot-auto-prompt' && method === 'POST') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const context = await buildShotAutomationContext({ shot_code: body.shot_code || body.shot, cut_id: body.cut_id });
    if (!context.shot_code && !context.cut_id) return json({ error: 'shot_code or cut_id required' }, 400);
    const promptPackage = await generateShotSeedancePrompt(context, body.options || {});
    return json({ success: true, prompt: promptPackage.prompt, prompt_package: promptPackage, context });
  }

  // POST /api/seedance/shot-auto-render ??admin only: breakdown -> Claude -> Seedance task
  if (path === '/api/seedance/shot-auto-render' && method === 'POST') {
    const auth = await requireSeedanceAdmin();
    if (auth.error) return auth.error;
    const apiKey = await getBytePlusKey();
    if (!apiKey) return json({ error: 'BytePlus API key is not configured' }, 400);
    const body = await request.json().catch(() => ({}));
    const context = await buildShotAutomationContext({ shot_code: body.shot_code || body.shot, cut_id: body.cut_id });
    if (!context.shot_code && !context.cut_id) return json({ error: 'shot_code or cut_id required' }, 400);
    const promptPackage = await generateShotSeedancePrompt(context, body.options || {});
    const refs = Array.isArray(promptPackage.references) ? promptPackage.references : [];
    const contextRefs = context.r2_references || [];
    const playblast = context.playblasts?.[0]?.url || contextRefs.find(r => r.type === 'video')?.url || '';
    const imageRefs = refs.concat(contextRefs)
      .map(r => typeof r === 'string' ? r : r?.url)
      .filter(Boolean)
      .filter(u => !playblast || u !== playblast)
      .slice(0, 12);
    const params = promptPackage.params || {};
    const MODEL_MAP = {
      'seedance-2-0': 'dreamina-seedance-2-0-260128',
      'seedance-2-0-fast': 'dreamina-seedance-2-0-fast-260128',
      'seedance-2': 'dreamina-seedance-2-0-260128',
      'seedance-2-fast': 'dreamina-seedance-2-0-fast-260128',
      'standard': 'dreamina-seedance-2-0-260128',
      'fast': 'dreamina-seedance-2-0-fast-260128'
    };
    const mode = params.mode || (playblast ? 'omni_reference' : 'text_to_video');
    const model = MODEL_MAP[body.model || params.model] || body.model || params.model || 'dreamina-seedance-2-0-260128';
    const duration = normalizeSeedanceDuration(body.duration || params.duration || context.cut?.duration || 5);
    const aspectRatio = body.aspect_ratio || params.aspect_ratio || 'adaptive';
    const objectRefs = refs.filter(r => r && typeof r === 'object' && r.url).slice(0, 12);
    const content = buildSeedanceContent({
      prompt: promptPackage.prompt,
      references: objectRefs,
      ref_image_urls: imageRefs.length ? imageRefs : undefined,
      source_url: playblast || undefined,
      mode
    });
    let bpResult;
    try {
      const bpResp = await fetch(BYTEPLUS_BASE + '/contents/generations/tasks', {
        method: 'POST',
        headers: byteHeaders(apiKey),
        body: JSON.stringify({
          model,
          content,
          ratio: resolveSeedanceRatio(aspectRatio, objectRefs),
          duration,
          generate_audio: body.generate_audio === true,
          watermark: body.watermark !== false
        })
      });
      bpResult = await bpResp.json();
    } catch (e) {
      return json({ error: 'BytePlus API request failed: ' + e.message }, 502);
    }
    if (!bpResult.id) return json({ error: 'BytePlus task creation failed', detail: bpResult, prompt_package: promptPackage }, 502);
    const jobId = guideId('SEED');
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO seedance_jobs (id, task_id, session_id, cut_id, shot_id, mode, model, prompt, source_url, ref_image_urls, duration, aspect_ratio, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      jobId, bpResult.id, context.cut?.episode_id || body.episode || '', body.cut_id || context.cut_id || '', context.shot_code || body.shot_code || '',
      mode, model, promptPackage.prompt, playblast || '', JSON.stringify(imageRefs), duration,
      aspectRatio, 'pending', auth.user.email || auth.user.name || auth.user.id || 'admin', now, now
    ).run();
    return json({ success: true, job: { id: jobId, task_id: bpResult.id, status: 'pending' }, prompt_package: promptPackage, context });
  }

  // POST /api/seedance/characters ??Turbo One character/prop/mech reference sheet upload
  if (path === '/api/seedance/characters' && method === 'POST') {
    if (!env.ASSETS) return json({ error: 'R2 ASSETS 誘몄꽕?' }, 500);
    const formData = await request.formData();
    const assetType = normalizeSeedanceAssetType(formData.get('asset_type'));
    const assetCode = normalizeSeedanceAssetCode(formData.get('asset_code'));
    const assetName = normalizeSeedanceAssetName(formData.get('asset_name'));
    const role = normalizeReferenceRole(formData.get('role'));
    const tags = String(formData.get('tags') || '').trim().slice(0, 300);
    const notes = String(formData.get('notes') || '').trim().slice(0, 2000);
    const files = formData.getAll('files').filter(file => file && typeof file.arrayBuffer === 'function');
    if (!files.length) return json({ error: 'files[] ?대?吏媛 ?꾩슂?⑸땲??' }, 400);

    const folder = `${assetType}${assetCode}_${assetName}`;
    const existing = await db.prepare('SELECT * FROM seedance_character_sheets WHERE folder=?').bind(folder).first();
    const existingFiles = existing ? parseCharacterFiles(existing.files_json).map(({ url, ...file }) => file) : [];
    const uploaded = [];
    const nowMs = Date.now();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const contentType = file.type || 'application/octet-stream';
      if (!contentType.startsWith('image/')) continue;
      if (file.size && file.size > 15 * 1024 * 1024) return json({ error: '?대?吏???뚯씪??15MB ?댄븯留?吏?먰빀?덈떎.' }, 413);
      const body = await file.arrayBuffer();
      const safeName = String(file.name || `sheet_${i}.png`).replace(/[^A-Za-z0-9_.-]+/g, '_');
      const key = `CharacterSheets/${folder}/${role}_${nowMs}_${i}_${safeName}`;
      await env.ASSETS.put(key, body, { httpMetadata: { contentType } });
      uploaded.push({
        key,
        filename: safeName,
        original_name: file.name || safeName,
        type: role,
        role,
        size: file.size || body.byteLength,
        content_type: contentType
      });
    }
    if (!uploaded.length) return json({ error: '?낅줈??媛?ν븳 ?대?吏 ?뚯씪???놁뒿?덈떎.' }, 400);

    const allFiles = existingFiles.concat(uploaded);
    const coverUrl = existing?.cover_url || characterFileToPublic(uploaded[0]).url;
    const now = Math.floor(Date.now() / 1000);
    if (existing) {
      await db.prepare(`UPDATE seedance_character_sheets
        SET asset_type=?, asset_code=?, asset_name=?, tags=?, notes=?, files_json=?, cover_url=?, updated_at=?
        WHERE folder=?`).bind(assetType, assetCode, assetName, tags, notes, JSON.stringify(allFiles), coverUrl, now, folder).run();
    } else {
      await db.prepare(`INSERT INTO seedance_character_sheets
        (folder, asset_type, asset_code, asset_name, tags, notes, files_json, cover_url, use_count, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(folder, assetType, assetCode, assetName, tags, notes, JSON.stringify(allFiles), coverUrl, 0, now, now).run();
    }
    return json({
      success: true,
      character: { folder, asset_type: assetType, asset_code: assetCode, asset_name: assetName, tags, notes, file_count: allFiles.length, cover_url: coverUrl },
      files: uploaded.map(characterFileToPublic)
    }, existing ? 200 : 201);
  }

  // GET /api/seedance/characters ??CharacterSheets/ ?대뜑 紐⑸줉 諛섑솚
  if (path === '/api/seedance/characters' && method === 'GET') {
    if (!env.ASSETS) return json({ error: 'R2 ASSETS 誘몄꽕?' }, 500);
    const rows = await db.prepare('SELECT * FROM seedance_character_sheets ORDER BY asset_type, asset_code, asset_name').all();
    const metadataCharacters = (rows.results || []).map(characterRowToPublic);
    const seen = new Set(metadataCharacters.map(item => item.folder));
    const listing = await env.ASSETS.list({ prefix: 'CharacterSheets/', delimiter: '/' });
    const fallbackCharacters = (listing.delimitedPrefixes || []).map(prefix => {
      const folderName = prefix.replace('CharacterSheets/', '').replace(/\/$/, '');
      if (seen.has(folderName)) return null;
      const m = folderName.match(/^(CH|PROP|MECH)(\d+)_(.+)$/);
      return {
        folder: folderName,
        key: folderName,
        prefix,
        id: m ? (m[1] + m[2]) : folderName,
        type: m ? m[1] : 'CH',
        asset_type: m ? m[1] : 'CH',
        number: m ? m[2] : '',
        asset_code: m ? m[2] : '',
        name: m ? m[3] : folderName,
        asset_name: m ? m[3] : folderName,
        file_count: 0,
        files_count: 0,
        cover_url: '',
      };
    }).filter(Boolean);
    return json({ success: true, characters: metadataCharacters.concat(fallbackCharacters) });
  }

  // GET /api/seedance/characters/:folder/files ??罹먮┃???대뜑 ???뚯씪 紐⑸줉
  const charFilesMatch = path.match(/^\/api\/seedance\/characters\/([^/]+)\/files$/);
  if (charFilesMatch && method === 'GET') {
    if (!env.ASSETS) return json({ error: 'R2 ASSETS 誘몄꽕?' }, 500);
    const folder = decodeURIComponent(charFilesMatch[1]);
    const row = await db.prepare('SELECT * FROM seedance_character_sheets WHERE folder=?').bind(folder).first();
    if (row) return json({ success: true, files: parseCharacterFiles(row.files_json) });
    const listing = await env.ASSETS.list({ prefix: `CharacterSheets/${folder}/` });
    const files = (listing.objects || []).map(obj => {
      const filename = obj.key.split('/').pop();
      const typeMatch = filename.match(/^(body|face|turnaround|prop|mech|other)_/i) || filename.match(/_(body|face|turnaround|prop|mech|other)\./i);
      return {
        key: obj.key,
        filename,
        type: typeMatch ? typeMatch[1].toLowerCase() : 'other',
        url: `/api/seedance/charimg/${encodeURIComponent(obj.key)}`,
        size: obj.size,
      };
    });
    return json({ success: true, files });
  }

  // GET /api/seedance/charimg/:r2key ??罹먮┃???쒗듃 ?대?吏 ?쒕튃 (ASSETS 踰꾪궥)
  if (path.startsWith('/api/seedance/charimg/') && method === 'GET') {
    if (!env.ASSETS) return json({ error: 'R2 ASSETS 誘몄꽕?' }, 500);
    const r2Key = decodeURIComponent(path.replace('/api/seedance/charimg/', ''));
    const object = await env.ASSETS.get(r2Key);
    if (!object) return json({ error: 'Not found: ' + r2Key }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(object.body, { status: 200, headers });
  }

  // POST /api/seedance/auto-prompt ??AI媛 ??而??ㅻ챸?먯꽌 Seedance ?꾨＼?꾪듃 ?먮룞 ?앹꽦
  if (path === '/api/seedance/auto-prompt' && method === 'POST') {
    const { cut_id, shot_code, description: manualDesc, style } = await request.json();
    let desc = manualDesc || '';
    let cutInfo = null;
    if (!desc && cut_id) {
      cutInfo = await db.prepare(
        `SELECT c.description, c.duration, c.cut_number, e.title as ep_title
         FROM sb_cuts c LEFT JOIN sb_episodes e ON c.episode_id = e.id WHERE c.id = ?`
      ).bind(cut_id).first();
      if (cutInfo) desc = cutInfo.description || '';
    }
    if (!desc && shot_code) {
      const shot = await db.prepare('SELECT description, note, scene FROM shots WHERE shot_code = ?').bind(shot_code).first();
      if (shot) desc = shot.description || shot.note || '';
    }
    if (!desc) return json({ error: '?ㅻ챸 ?곗씠?곌? ?놁뒿?덈떎. cut_id, shot_code, ?먮뒗 description???쒓났?섏꽭??' }, 400);
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY 誘몄꽕?' }, 500);
    const styleGuide = style || '3D animated robot action anime, cinematic lighting, 4K quality';
    try {
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 400,
          messages: [{ role: 'user', content: `Scene description: ${desc}\nDuration: ${cutInfo?.duration || 5}s` }],
          system: `You are a Seedance 2.0 video generation prompt engineer for a 3D robot action anime "Turbo One".
Convert the Korean scene description into an optimized English Seedance prompt.
Rules: Start with visual action, then camera movement, then lighting/mood.
Use camera terms: [Low-angle shot], [Tracking shot], [Close-up], [Wide shot], [Dutch angle], [Crane shot].
Include lighting: dramatic rim lighting, volumetric fog, golden-hour, cold blue shadows.
Include quality keywords: cinematic, 4K, detailed. Keep under 200 words. Style: ${styleGuide}
Output ONLY the English prompt.`
        })
      });
      const aiData = await aiResp.json();
      const prompt = aiData.content?.[0]?.text || '';
      if (!prompt) return json({ error: 'AI ?묐떟 ?놁쓬', detail: aiData }, 500);
      return json({ success: true, prompt, source_description: desc, cut_info: cutInfo || null });
    } catch (e) { return json({ error: 'Claude API ?ㅻ쪟: ' + e.message }, 502); }
  }

  // POST /api/seedance/batch-render ???щ윭 而룹쓣 ?쒕쾲???뚮뜑 ?먯뿉 ?깅줉
  if (path === '/api/seedance/batch-render' && method === 'POST') {
    const apiKey = await getBytePlusKey();
    if (!apiKey) return json({ error: 'BytePlus API ??誘몄꽕?' }, 400);
    const { cut_ids, mode, model, duration, aspect_ratio, style, created_by, generate_audio, watermark } = await request.json();
    if (!cut_ids || !cut_ids.length) return json({ error: 'cut_ids 諛곗뿴 ?꾩닔' }, 400);
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY 誘몄꽕?' }, 500);
    const results = [], errors = [];
    const taskMode = mode || 'text_to_video';
    const taskDuration = normalizeSeedanceDuration(duration);
    const taskAspect = resolveSeedanceRatio(aspect_ratio);
    const styleGuide = style || '3D animated robot action anime, cinematic lighting, 4K quality';
    const MODEL_MAP = { 'seedance-2-0':'dreamina-seedance-2-0-260128','seedance-2-0-fast':'dreamina-seedance-2-0-fast-260128','seedance-2':'dreamina-seedance-2-0-260128','seedance-2-fast':'dreamina-seedance-2-0-fast-260128' };
    const bpModel = MODEL_MAP[model] || model || 'dreamina-seedance-2-0-260128';
    for (const cutId of cut_ids) {
      try {
        const cutInfo = await db.prepare(
          `SELECT c.description, c.duration, c.cut_number, c.shot_id, e.title as ep_title
           FROM sb_cuts c LEFT JOIN sb_episodes e ON c.episode_id = e.id WHERE c.id = ?`
        ).bind(cutId).first();
        if (!cutInfo || !cutInfo.description) { errors.push({ cut_id: cutId, error: '?ㅻ챸 ?놁쓬' }); continue; }
        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 400,
            messages: [{ role: 'user', content: `Scene: ${cutInfo.description}\nDuration: ${cutInfo.duration || taskDuration}s` }],
            system: `Convert Korean scene description to English Seedance 2.0 prompt. Style: ${styleGuide}. Use camera terms. Include lighting and quality keywords. Output ONLY the prompt.`
          })
        });
        const aiData = await aiResp.json();
        const prompt = aiData.content?.[0]?.text || '';
        if (!prompt) { errors.push({ cut_id: cutId, error: 'AI ?꾨＼?꾪듃 ?앹꽦 ?ㅽ뙣' }); continue; }
        const content = [{ type: 'text', text: prompt }];
        const bpResp = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks', {
          method: 'POST',
          headers: byteHeaders(apiKey),
          body: JSON.stringify({
            model: bpModel,
            content,
            ratio: taskAspect,
            duration: normalizeSeedanceDuration(cutInfo.duration || taskDuration),
            generate_audio: generate_audio === true,
            watermark: watermark !== false
          })
        });
        const bpResult = await bpResp.json();
        if (!bpResult.id) { errors.push({ cut_id: cutId, error: 'BytePlus ?묒뾽 ?앹꽦 ?ㅽ뙣', detail: bpResult }); continue; }
        const jobId = guideId('SEED');
        const now = Math.floor(Date.now() / 1000);
        await db.prepare(
          `INSERT INTO seedance_jobs (id, task_id, session_id, cut_id, shot_id, mode, model, prompt, source_url, ref_image_urls, duration, aspect_ratio, status, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(jobId, bpResult.id, '', cutId, cutInfo.shot_id || '', taskMode, bpModel, prompt, '', '[]', normalizeSeedanceDuration(cutInfo.duration || taskDuration), taskAspect, 'pending', created_by || 'auto', now, now).run();
        results.push({ cut_id: cutId, job_id: jobId, task_id: bpResult.id, prompt: prompt.slice(0, 80) + '...' });
      } catch (e) { errors.push({ cut_id: cutId, error: e.message }); }
    }
    return json({ success: true, total: cut_ids.length, submitted: results.length, failed: errors.length, jobs: results, errors });
  }

  // POST /api/seedance/extend ??湲곗〈 ?곸긽 湲곕컲 ?곗옣/?ㅽ떚移??묒뾽 ?앹꽦
  if ((path === '/api/seedance/extend' || path === '/api/seedance/stitch') && method === 'POST') {
    const body = await request.json();
    const { prompt, video_url, video_urls, source_url, duration, aspect_ratio, model, shot_id, cut_id, session_id, created_by, generate_audio, watermark } = body;
    const clips = Array.isArray(video_urls) ? video_urls : [];
    const primaryVideo = video_url || source_url || (typeof clips[0] === 'string' ? clips[0] : clips[0]?.url);
    if (!primaryVideo) return json({ error: 'video_url ?먮뒗 video_urls 諛곗뿴???꾩슂?⑸땲??' }, 400);

    const apiKey = await getBytePlusKey();
    if (!apiKey) return json({ error: 'BytePlus API ??誘몄꽕?' }, 400);

    const MODEL_MAP = {
      'seedance-2-0': 'dreamina-seedance-2-0-260128',
      'seedance-2-0-fast': 'dreamina-seedance-2-0-fast-260128',
      'seedance-2': 'dreamina-seedance-2-0-260128',
      'seedance-2-fast': 'dreamina-seedance-2-0-fast-260128',
      'standard': 'dreamina-seedance-2-0-260128',
      'fast': 'dreamina-seedance-2-0-fast-260128'
    };
    const taskModel = MODEL_MAP[model] || model || 'dreamina-seedance-2-0-260128';
    const taskMode = path.endsWith('/stitch') ? 'stitch_video' : 'extend_video';
    const taskDuration = normalizeSeedanceDuration(duration);
    const taskAspect = resolveSeedanceRatio(aspect_ratio, clips);
    const taskPrompt = prompt || (taskMode === 'stitch_video'
      ? 'Stitch the reference clips into one continuous cinematic 3D animation shot with consistent motion, lighting, and camera continuity.'
      : 'Extend the reference video into a continuous cinematic 3D animation shot, preserving character motion, camera direction, lighting, and style.');
    const extraVideos = (video_url || source_url) ? clips : clips.slice(1);
    const content = buildSeedanceContent({
      prompt: taskPrompt,
      source_url: primaryVideo,
      video_urls: extraVideos,
      mode: taskMode
    });

    let bpResult;
    try {
      const bpResp = await fetch(BYTEPLUS_BASE + '/contents/generations/tasks', {
        method: 'POST',
        headers: byteHeaders(apiKey),
        body: JSON.stringify({
          model: taskModel,
          content,
          ratio: taskAspect,
          duration: taskDuration,
          generate_audio: generate_audio === true,
          watermark: watermark !== false
        })
      });
      bpResult = await bpResp.json();
    } catch (e) {
      return json({ error: 'BytePlus API ?붿껌 ?ㅽ뙣: ' + e.message }, 502);
    }
    if (!bpResult.id) return json({ error: 'BytePlus ?묒뾽 ?앹꽦 ?ㅽ뙣', detail: bpResult }, 502);

    const jobId = guideId('SEED');
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO seedance_jobs (id, task_id, session_id, cut_id, shot_id, mode, model, prompt, source_url, ref_image_urls, duration, aspect_ratio, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      jobId, bpResult.id, session_id||'', cut_id||'', shot_id||'',
      taskMode, taskModel, taskPrompt, primaryVideo,
      JSON.stringify(clips), taskDuration, taskAspect, 'pending', created_by||'director', now, now
    ).run();

    return json({ success: true, job: { id: jobId, task_id: bpResult.id, status: 'pending', mode: taskMode } });
  }

  // GET /api/seedance/shots-list ????而??쒕∼?ㅼ슫??紐⑸줉
  if (path === '/api/seedance/shots-list' && method === 'GET') {
    const url = new URL(request.url);
    const episode = url.searchParams.get('episode') || '';
    let q = `SELECT c.id, c.cut_number, c.description, c.duration, c.shot_id, c.status,
             e.id as episode_id, e.title as ep_title
             FROM sb_cuts c LEFT JOIN sb_episodes e ON c.episode_id = e.id
             WHERE c.description IS NOT NULL AND c.description != ''`;
    let params = [];
    if (episode) { q += ` AND e.id LIKE ?`; params.push('%' + episode + '%'); }
    q += ' ORDER BY e.id, c.cut_number LIMIT 200';
    const cuts = await db.prepare(q).bind(...params).all();
    const episodes = await db.prepare(
      `SELECT DISTINCT e.id, e.title FROM sb_episodes e
       INNER JOIN sb_cuts c ON c.episode_id = e.id
       WHERE c.description IS NOT NULL AND c.description != '' ORDER BY e.id`
    ).all();
    return json({ success: true, cuts: cuts.results, episodes: episodes.results });
  }

  return json({ error: 'Seedance API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// =============================================================================
// GPT Image 2 API ??Design/Modeling ?뚰듃 ?꾩슜
// =============================================================================
async function handleGPTImageAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  await db.prepare(`CREATE TABLE IF NOT EXISTS gpt_image_jobs (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    dept TEXT DEFAULT 'design',
    asset_link TEXT DEFAULT '',
    size TEXT DEFAULT '1024x1024',
    quality TEXT DEFAULT 'high',
    n INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    result_url TEXT,
    r2_key TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();

  // GET /api/gpt-image/config
  if (path === '/api/gpt-image/config' && method === 'GET') {
    const key = env.OPENAI_API_KEY || '';
    return json({ configured: !!key, masked: key ? '****' + key.slice(-4) : null });
  }

  // POST /api/gpt-image/config
  if (path === '/api/gpt-image/config' && method === 'POST') {
    return json({ error: 'OpenAI API key must be configured as Worker Secret OPENAI_API_KEY. D1 app_config storage is disabled.' }, 410);
  }

  // GET /api/gpt-image/jobs
  if (path === '/api/gpt-image/jobs' && method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));
    const rows = await db.prepare('SELECT * FROM gpt_image_jobs ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    return json({ jobs: rows.results || [] });
  }

  // DELETE /api/gpt-image/jobs/:id
  const delMatch = path.match(/^\/api\/gpt-image\/jobs\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    await db.prepare('DELETE FROM gpt_image_jobs WHERE id=?').bind(delMatch[1]).run();
    return json({ success: true });
  }

  // POST /api/gpt-image/auto-prompt ??Claude濡??대?吏 ?꾨＼?꾪듃 ?먮룞 ?앹꽦
  if (path === '/api/gpt-image/auto-prompt' && method === 'POST') {
    const body = await request.json();
    const dept = body.dept || 'design';
    const asset = body.asset_name || '';
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);

    const sysPrompt = dept === 'design'
      ? 'You generate GPT Image 2 prompts for 3D animation concept art. Output a single English prompt optimized for character/environment design sheets. Include: art style (3D render, concept art), subject details, camera angle, lighting, background. Keep under 200 words.'
      : 'You generate GPT Image 2 prompts for 3D modeling reference images. Output a single English prompt for modeling reference sheets (turnaround, orthographic views). Include: clean background, consistent lighting, technical accuracy. Keep under 200 words.';
    const userMsg = asset ? 'Generate a prompt for: ' + asset : 'Generate a general ' + dept + ' reference image prompt for a 3D mecha robot anime production.';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, system: sysPrompt, messages: [{ role: 'user', content: userMsg }] })
    });
    const aiData = await aiRes.json();
    const prompt = aiData.content?.[0]?.text || '';
    return json({ prompt: prompt.trim() });
  }

  // POST /api/gpt-image/generate
  if (path === '/api/gpt-image/generate' && method === 'POST') {
    const body = await request.json();
    if (!body.prompt) return json({ error: 'prompt ?꾩닔' }, 400);

    const openAiKey = env.OPENAI_API_KEY || '';
    if (!openAiKey) return json({ error: 'OpenAI API ??誘몄꽕?? Worker Secret OPENAI_API_KEY瑜??ㅼ젙?섏꽭??' }, 400);

    const jobId = 'gimg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    await db.prepare('INSERT INTO gpt_image_jobs (id,prompt,dept,asset_link,size,quality,n,status) VALUES (?,?,?,?,?,?,?,?)')
      .bind(jobId, body.prompt, body.dept||'design', body.asset_link||'', body.size||'1024x1024', body.quality||'high', body.n||1, 'processing').run();

    try {
      const oaiRes = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openAiKey },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: body.prompt,
          n: body.n || 1,
          size: body.size || '1024x1024',
          quality: body.quality || 'high'
        })
      });
      const oaiData = await oaiRes.json();
      if (oaiData.error) {
        await db.prepare("UPDATE gpt_image_jobs SET status='failed', error=?, updated_at=datetime('now') WHERE id=?")
          .bind(oaiData.error.message || JSON.stringify(oaiData.error), jobId).run();
        return json({ success: false, error: oaiData.error.message });
      }

      // b64_json 寃곌낵瑜?R2?????
      const imgData = oaiData.data?.[0];
      let resultUrl = '';
      let r2Key = '';

      if (imgData?.b64_json) {
        const buf = Uint8Array.from(atob(imgData.b64_json), c => c.charCodeAt(0));
        r2Key = 'gpt-images/' + jobId + '.png';
        await env.ASSETS.put(r2Key, buf, { httpMetadata: { contentType: 'image/png' } });
        resultUrl = '/r2/public/' + r2Key;
      } else if (imgData?.url) {
        resultUrl = imgData.url;
      }

      await db.prepare("UPDATE gpt_image_jobs SET status='completed', result_url=?, r2_key=?, updated_at=datetime('now') WHERE id=?")
        .bind(resultUrl, r2Key, jobId).run();
      return json({ success: true, job_id: jobId, result_url: resultUrl });
    } catch (e) {
      await db.prepare("UPDATE gpt_image_jobs SET status='failed', error=?, updated_at=datetime('now') WHERE id=?")
        .bind(e.message, jobId).run();
      return json({ success: false, error: e.message });
    }
  }

  return json({ error: 'GPT Image API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// =============================================================================
// ?대?吏 ?앹꽦 API ??imagegen_jobs + app_config 湲곕컲
// =============================================================================
async function handleImagegenAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  await db.prepare(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS imagegen_jobs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    prompt TEXT,
    negative_prompt TEXT,
    style TEXT DEFAULT '',
    mode TEXT DEFAULT 'text_to_image',
    width INTEGER DEFAULT 1024,
    height INTEGER DEFAULT 1024,
    count INTEGER DEFAULT 1,
    model TEXT DEFAULT 'gemini-2.0-flash-exp',
    status TEXT DEFAULT 'pending',
    result_urls TEXT DEFAULT '[]',
    r2_keys TEXT DEFAULT '[]',
    ref_image_key TEXT,
    error TEXT,
    created_by TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`).run();

  // GET /api/imagegen/config ??API ???ㅼ젙 ?곹깭 諛섑솚
  if (path === '/api/imagegen/config' && method === 'GET') {
    const bpKey  = env.BYTEPLUS_API_KEY || '';
    const gemKey = env.GEMINI_API_KEY || '';
    const sdKey  = env.STABILITY_API_KEY || '';

    const configured = !!(bpKey || gemKey || sdKey);
    let provider = null;
    const providers = [];
    if (bpKey)  providers.push({ name: 'BytePlus/Ark',   masked: '****' + bpKey.slice(-4) });
    if (gemKey) providers.push({ name: 'Gemini',         masked: '****' + gemKey.slice(-4) });
    if (sdKey)  providers.push({ name: 'Stability AI',   masked: '****' + sdKey.slice(-4) });
    if (providers.length) provider = providers[0].name;

    // ???듦퀎
    const stats = await db.prepare(`
      SELECT status, COUNT(*) as cnt FROM imagegen_jobs GROUP BY status
    `).all();
    const counts = {};
    (stats.results || []).forEach(r => { counts[r.status] = r.cnt; });

    return json({ success: true, configured, provider, providers, job_counts: counts });
  }

  // POST /api/imagegen/config ??API ?????
  if (path === '/api/imagegen/config' && method === 'POST') {
    return json({ error: 'Image generation API keys must be configured as Worker Secrets. D1 app_config storage is disabled.' }, 410);
  }

  // GET /api/imagegen/jobs ??理쒖떊 50嫄?紐⑸줉
  if (path === '/api/imagegen/jobs' && method === 'GET') {
    const url = new URL(request.url);
    const limit  = Math.min(100, parseInt(url.searchParams.get('limit')  || '50'));
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const status = url.searchParams.get('status');

    let q = 'SELECT * FROM imagegen_jobs';
    const params = [];
    if (status) { q += ' WHERE status=?'; params.push(status); }
    q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const jobs = await db.prepare(q).bind(...params).all();
    const total = await db.prepare(
      status ? 'SELECT COUNT(*) as n FROM imagegen_jobs WHERE status=?' : 'SELECT COUNT(*) as n FROM imagegen_jobs'
    ).bind(...(status ? [status] : [])).first();

    return json({ success: true, jobs: jobs.results || [], total: total?.n || 0 });
  }

  // DELETE /api/imagegen/jobs/:id ??????젣
  const delMatch = path.match(/^\/api\/imagegen\/jobs\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    const id = delMatch[1];
    await db.prepare('DELETE FROM imagegen_jobs WHERE id=?').bind(id).run();
    return json({ success: true });
  }

  return json({ error: 'Imagegen API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// =============================================================================
// ?뚮┝/由ы룷??API ??progress_reports + cowork_events ?듯빀 酉?// =============================================================================
async function handleReportsAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  // ?뚯씠釉?珥덇린??(IF NOT EXISTS ???덉쟾)
  await db.prepare(`CREATE TABLE IF NOT EXISTS progress_reports (
    id TEXT PRIMARY KEY,
    report_type TEXT DEFAULT 'progress',
    content TEXT,
    slack_sent INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS cowork_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    agent_name TEXT,
    task_id TEXT,
    payload TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  // 湲곗〈 ?뚯씠釉붿뿉 is_read 而щ읆 ?놁쓣 ???덉쑝誘濡?ALTER TABLE ?쒕룄
  try { await db.prepare("ALTER TABLE progress_reports ADD COLUMN is_read INTEGER DEFAULT 0").run(); } catch(e) {}
  try { await db.prepare("ALTER TABLE cowork_events ADD COLUMN is_read INTEGER DEFAULT 0").run(); } catch(e) {}

  // GET /api/reports ???듯빀 50嫄?(理쒖떊??
  if (path === '/api/reports' && method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));
    const type = url.searchParams.get('type') || 'all'; // all | report | event

    let rows = [];
    if (type !== 'event') {
      const rpts = await db.prepare(
        `SELECT 'rpt_'||id AS uid, 'report' AS source, report_type AS subtype,
                content AS body, is_read,
                datetime(created_at, 'unixepoch') AS ts, created_at AS ts_raw
         FROM progress_reports ORDER BY created_at DESC LIMIT ?`
      ).bind(limit).all();
      rows = rows.concat(rpts.results || []);
    }
    if (type !== 'report') {
      const evts = await db.prepare(
        `SELECT 'evt_'||id AS uid, 'event' AS source, event_type AS subtype,
                COALESCE(payload, json_object('agent', agent_name, 'task_id', task_id)) AS body,
                is_read,
                CASE WHEN typeof(created_at)='integer' THEN datetime(created_at,'unixepoch')
                     ELSE created_at END AS ts,
                CASE WHEN typeof(created_at)='integer' THEN created_at
                     ELSE unixepoch(created_at) END AS ts_raw
         FROM cowork_events ORDER BY created_at DESC LIMIT ?`
      ).bind(limit).all();
      rows = rows.concat(evts.results || []);
    }

    // 蹂묓빀 ??理쒖떊???뺣젹, limit ?곸슜
    rows.sort((a, b) => (b.ts_raw || 0) - (a.ts_raw || 0));
    rows = rows.slice(0, limit);

    const unread = rows.filter(r => !r.is_read).length;
    return json({ success: true, items: rows, total: rows.length, unread });
  }

  // GET /api/reports/unread-count
  if (path === '/api/reports/unread-count' && method === 'GET') {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM progress_reports WHERE is_read=0").first();
    const e = await db.prepare("SELECT COUNT(*) AS n FROM cowork_events WHERE is_read=0").first();
    const count = (r?.n || 0) + (e?.n || 0);
    return json({ success: true, count });
  }

  // POST /api/reports/:uid/read ???쎌쓬 泥섎━ (uid ?뺤떇: rpt_xxx ?먮뒗 evt_123)
  const readMatch = path.match(/^\/api\/reports\/([^/]+)\/read$/);
  if (readMatch && method === 'POST') {
    const uid = readMatch[1];
    if (uid === 'all') {
      await db.prepare("UPDATE progress_reports SET is_read=1").run();
      await db.prepare("UPDATE cowork_events SET is_read=1").run();
      return json({ success: true, marked: 'all' });
    }
    if (uid.startsWith('rpt_')) {
      const id = uid.slice(4);
      await db.prepare("UPDATE progress_reports SET is_read=1 WHERE id=?").bind(id).run();
    } else if (uid.startsWith('evt_')) {
      const id = parseInt(uid.slice(4));
      await db.prepare("UPDATE cowork_events SET is_read=1 WHERE id=?").bind(id).run();
    }
    return json({ success: true, uid });
  }

  return json({ error: 'Reports API ?붾뱶?ъ씤?몃? 李얠쓣 ???놁뒿?덈떎: ' + path }, 404);
}

// =============================================================================
// Opus 4.7 Production Analysis Pipeline
// ?ㅽ넗由щ낫???대?吏 + ?곗텧媛?대뱶 ?곸긽 + Maya ?뚮젅?대툝?쇱뒪????Opus 4.7 遺꾩꽍 ??Obsidian 吏?앺솕
// =============================================================================

// ??? ?쇱슦??(handleAnalysisPipelineAPI) ??????????????????????????????????????
// worker.js fetch()??異붽?:
//   if (path.startsWith('/api/analysis/')) {
//     const res = await handleAnalysisPipelineAPI(path, request, env);
//     return addCors(res);
//   }

async function handleAnalysisPipelineAPI(path, request, env) {
  const method = request.method;
  const user = await authenticateAny(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if (!['admin', 'pd'].includes(user.role)) {
    return json({ error: 'admin/pd 沅뚰븳 ?꾩슂' }, 403);
  }

  const db = env.DB;
  await initAnalysisTables(db);

  // ??? 1. ?뚯씪 ?낅줈??(?ㅽ넗由щ낫??媛?대뱶/?뚮젅?대툝?쇱뒪?? ????????????
  // POST /api/analysis/upload
  // FormData: file, cut_code, file_type(storyboard|guide|playblast), episode_id
  if (path === '/api/analysis/upload' && method === 'POST') {
    return analysisUpload(request, env, user);
  }

  // ??? 2. Opus 4.7 遺꾩꽍 ?몃━嫄???????????????????????????????????????
  // POST /api/analysis/analyze
  // body: { cut_code, file_types: ['storyboard','guide','playblast'] }
  if (path === '/api/analysis/analyze' && method === 'POST') {
    return analysisRunOpus(request, env, user);
  }

  // ??? 3. 遺꾩꽍 寃곌낵 議고쉶 ????????????????????????????????????????????
  // GET /api/analysis/result?cut_code=EP01_CUT001
  if (path === '/api/analysis/result' && method === 'GET') {
    return analysisGetResult(request, env);
  }

  // ??? 4. 遺꾩꽍 寃곌낵 ??Obsidian 留덊겕?ㅼ슫 蹂??+ R2 ????????????????
  // POST /api/analysis/to-obsidian
  // body: { cut_code } ?먮뒗 { episode_id } (?먰뵾?뚮뱶 ?꾩껜)
  if (path === '/api/analysis/to-obsidian' && method === 'POST') {
    return analysisToObsidian(request, env, user);
  }

  // ??? 5. ?먰뵾?뚮뱶 ?꾩껜 遺꾩꽍 (諛곗튂) ?????????????????????????????????
  // POST /api/analysis/batch
  // body: { episode_id, file_types: ['storyboard','guide','playblast'] }
  if (path === '/api/analysis/batch' && method === 'POST') {
    return analysisBatch(request, env, user);
  }

  // ??? 6. 遺꾩꽍 ?덉뒪?좊━ ?????????????????????????????????????????????
  // GET /api/analysis/history?episode_id=EP01&limit=50
  if (path === '/api/analysis/history' && method === 'GET') {
    return analysisHistory(request, env);
  }

  // ??? 7. Seedance ?꾨＼?꾪듃 ?앹꽦 (遺꾩꽍 湲곕컲) ????????????????????????
  // POST /api/analysis/generate-prompt
  // body: { cut_code }
  if (path === '/api/analysis/generate-prompt' && method === 'POST') {
    return analysisGeneratePrompt(request, env, user);
  }

  return json({ error: 'Analysis API ?붾뱶?ъ씤???놁쓬: ' + path }, 404);
}


// =============================================================================
// D1 ?뚯씠釉?珥덇린??// =============================================================================

async function initAnalysisTables(db) {
  // 遺꾩꽍???뚯씪 硫뷀??곗씠??
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS analysis_files (
      id          TEXT PRIMARY KEY,
      cut_code    TEXT NOT NULL,
      episode_id  TEXT NOT NULL,
      file_type   TEXT NOT NULL CHECK(file_type IN ('storyboard','guide','playblast')),
      r2_key      TEXT NOT NULL,
      r2_url      TEXT,
      filename    TEXT,
      content_type TEXT,
      file_size   INTEGER,
      uploaded_by TEXT,
      created_at  INTEGER DEFAULT (unixepoch()),
      UNIQUE(cut_code, file_type)
    )
  `).run();

  // Opus 4.7 遺꾩꽍 寃곌낵
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS analysis_results (
      id              TEXT PRIMARY KEY,
      cut_code        TEXT NOT NULL,
      episode_id      TEXT NOT NULL,
      analysis_type   TEXT NOT NULL CHECK(analysis_type IN ('storyboard','guide','playblast','combined')),
      model           TEXT NOT NULL DEFAULT 'claude-opus-4-7',
      result_json     TEXT NOT NULL,
      tokens_in       INTEGER DEFAULT 0,
      tokens_out      INTEGER DEFAULT 0,
      cost_usd        REAL DEFAULT 0,
      analyzed_by     TEXT,
      created_at      INTEGER DEFAULT (unixepoch()),
      version         INTEGER DEFAULT 1,
      UNIQUE(cut_code, analysis_type, version)
    )
  `).run();

  // Obsidian 留덊겕?ㅼ슫 ?앹꽦 濡쒓렇
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS analysis_obsidian_log (
      id          TEXT PRIMARY KEY,
      cut_code    TEXT NOT NULL,
      episode_id  TEXT NOT NULL,
      r2_path     TEXT NOT NULL,
      md_hash     TEXT,
      synced_at   INTEGER DEFAULT (unixepoch()),
      version     INTEGER DEFAULT 1
    )
  `).run();
}


// =============================================================================
// 1. ?뚯씪 ?낅줈??// =============================================================================

async function analysisUpload(request, env, user) {
  const formData = await request.formData();
  const file = formData.get('file');
  const cutCode = formData.get('cut_code');
  const fileType = formData.get('file_type'); // storyboard | guide | playblast
  const episodeId = formData.get('episode_id') || cutCode?.split('_')[0] || 'EP01';

  if (!file || !cutCode || !fileType) {
    return json({ error: 'file, cut_code, file_type ?꾩닔' }, 400);
  }
  if (!['storyboard', 'guide', 'playblast'].includes(fileType)) {
    return json({ error: 'file_type: storyboard/guide/playblast 以??섎굹' }, 400);
  }

  // R2 寃쎈줈: analysis/{episode}/{cut_code}/{file_type}/{filename}
  const ext = file.name?.split('.').pop() || (fileType === 'storyboard' ? 'png' : 'mp4');
  const r2Key = `analysis/${episodeId}/${cutCode}/${fileType}/${cutCode}_${fileType}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  await env.ASSETS.put(r2Key, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' }
  });

  const id = `AF_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const r2Url = `https://studiojun.co.kr/r2/${r2Key}`;

  await env.DB.prepare(`
    INSERT INTO analysis_files (id, cut_code, episode_id, file_type, r2_key, r2_url, filename, content_type, file_size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cut_code, file_type) DO UPDATE SET
      r2_key=excluded.r2_key, r2_url=excluded.r2_url, filename=excluded.filename,
      content_type=excluded.content_type, file_size=excluded.file_size,
      uploaded_by=excluded.uploaded_by, created_at=unixepoch()
  `).bind(id, cutCode, episodeId, fileType, r2Key, r2Url, file.name, file.type, arrayBuffer.byteLength, user.email || user.name).run();

  return json({
    success: true,
    id,
    cut_code: cutCode,
    file_type: fileType,
    r2_key: r2Key,
    r2_url: r2Url,
    size: arrayBuffer.byteLength
  });
}


// =============================================================================
// 2. Opus 4.7 遺꾩꽍 ?ㅽ뻾
// =============================================================================

async function analysisRunOpus(request, env, user) {
  const body = await request.json();
  const { cut_code, file_types = ['storyboard', 'guide', 'playblast'] } = body;

  if (!cut_code) return json({ error: 'cut_code ?꾩닔' }, 400);

  // ?낅줈?쒕맂 ?뚯씪 議고쉶
  const files = await env.DB.prepare(
    `SELECT * FROM analysis_files WHERE cut_code = ? AND file_type IN (${file_types.map(() => '?').join(',')})`
  ).bind(cut_code, ...file_types).all();

  if (!files.results?.length) {
    return json({ error: `${cut_code}???낅줈?쒕맂 ?뚯씪 ?놁쓬` }, 404);
  }

  const results = [];

  for (const file of files.results) {
    // R2?먯꽌 ?뚯씪 媛?몄삤湲?    const r2Object = await env.ASSETS.get(file.r2_key);
    if (!r2Object) continue;

    let analysisResult;

    if (file.file_type === 'storyboard') {
      // ?대?吏 遺꾩꽍 ??Opus 4.7 Vision
      const imageBytes = await r2Object.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(imageBytes)));
      const mediaType = file.content_type || 'image/png';

      analysisResult = await callOpus47Vision(env, {
        systemPrompt: STORYBOARD_ANALYSIS_PROMPT,
        imageBase64: base64,
        mediaType,
        userPrompt: `而?肄붾뱶: ${cut_code}\n???ㅽ넗由щ낫???대?吏瑜?遺꾩꽍?댁＜?몄슂.`
      });

    } else if (file.file_type === 'guide') {
      // ?곗텧媛?대뱶 ?곸긽 ???꾩옱???꾨젅??異붿텧 ??遺꾩꽍 (?ν썑 鍮꾨뵒??吏곸젒 遺꾩꽍)
      // TODO: ?곸긽?먯꽌 ?ㅽ봽?덉엫 異붿텧 ??硫?곗씠誘몄? 遺꾩꽍
      analysisResult = await callOpus47Text(env, {
        systemPrompt: GUIDE_ANALYSIS_PROMPT,
        userPrompt: `而?肄붾뱶: ${cut_code}\n?곗텧媛?대뱶 ?곸긽 ?뚯씪: ${file.r2_key}\n?뚯씪 ?ш린: ${file.file_size} bytes\n\n?꾩옱 ?곸긽 吏곸젒 遺꾩꽍 誘몄??? ?곗텧媛?대뱶 ?띿뒪??湲곕컲 遺꾩꽍?쇰줈 ?泥? 異뷀썑 Opus 4.7 鍮꾩쟾??鍮꾨뵒?ㅻ? 吏?먰븯硫??낃렇?덉씠??`
      });

    } else if (file.file_type === 'playblast') {
      // Maya ?뚮젅?대툝?쇱뒪?????꾨젅??異붿텧 ??遺꾩꽍
      // TODO: 鍮꾨뵒?ㅼ뿉???ㅽ봽?덉엫 異붿텧 ??硫?곗씠誘몄? 遺꾩꽍
      analysisResult = await callOpus47Text(env, {
        systemPrompt: PLAYBLAST_ANALYSIS_PROMPT,
        userPrompt: `而?肄붾뱶: ${cut_code}\n?뚮젅?대툝?쇱뒪???뚯씪: ${file.r2_key}\n?뚯씪 ?ш린: ${file.file_size} bytes\n\n?꾩옱 ?곸긽 吏곸젒 遺꾩꽍 誘몄??? 異뷀썑 ?ㅽ봽?덉엫 異붿텧 + 硫?곗씠誘몄? 遺꾩꽍?쇰줈 ?낃렇?덉씠??`
      });
    }

    if (analysisResult) {
      const resultId = `AR_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      // 湲곗〈 踰꾩쟾 議고쉶
      const existing = await env.DB.prepare(
        `SELECT MAX(version) as max_ver FROM analysis_results WHERE cut_code = ? AND analysis_type = ?`
      ).bind(cut_code, file.file_type).first();
      const newVersion = (existing?.max_ver || 0) + 1;

      await env.DB.prepare(`
        INSERT INTO analysis_results (id, cut_code, episode_id, analysis_type, model, result_json, tokens_in, tokens_out, cost_usd, analyzed_by, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        resultId, cut_code, file.episode_id, file.file_type,
        'claude-opus-4-7',
        JSON.stringify(analysisResult.result),
        analysisResult.usage?.input_tokens || 0,
        analysisResult.usage?.output_tokens || 0,
        analysisResult.cost || 0,
        user.email || user.name,
        newVersion
      ).run();

      results.push({
        file_type: file.file_type,
        result_id: resultId,
        version: newVersion,
        tokens: analysisResult.usage
      });
    }
  }

  // Combined 遺꾩꽍 (紐⑤뱺 媛쒕퀎 遺꾩꽍 寃곌낵 醫낇빀)
  if (results.length > 1) {
    const allResults = await env.DB.prepare(
      `SELECT analysis_type, result_json FROM analysis_results
       WHERE cut_code = ? AND version = (SELECT MAX(version) FROM analysis_results ar2 WHERE ar2.cut_code = analysis_results.cut_code AND ar2.analysis_type = analysis_results.analysis_type)
       ORDER BY analysis_type`
    ).bind(cut_code).all();

    if (allResults.results?.length > 1) {
      const combinedInput = allResults.results.map(r =>
        `### ${r.analysis_type} 遺꾩꽍:\n${r.result_json}`
      ).join('\n\n');

      const combinedResult = await callOpus47Text(env, {
        systemPrompt: COMBINED_ANALYSIS_PROMPT,
        userPrompt: `而?肄붾뱶: ${cut_code}\n\n?ㅼ쓬? 媛??뚰듃蹂?遺꾩꽍 寃곌낵?낅땲?? ?대? 醫낇빀?섏뿬 理쒖쥌 而?遺꾩꽍???묒꽦?댁＜?몄슂.\n\n${combinedInput}`
      });

      if (combinedResult) {
        const combId = `AR_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await env.DB.prepare(`
          INSERT INTO analysis_results (id, cut_code, episode_id, analysis_type, model, result_json, tokens_in, tokens_out, cost_usd, analyzed_by)
          VALUES (?, ?, ?, 'combined', 'claude-opus-4-7', ?, ?, ?, ?, ?)
        `).bind(
          combId, cut_code, files.results[0].episode_id,
          JSON.stringify(combinedResult.result),
          combinedResult.usage?.input_tokens || 0,
          combinedResult.usage?.output_tokens || 0,
          combinedResult.cost || 0,
          user.email || user.name
        ).run();

        results.push({ file_type: 'combined', result_id: combId });
      }
    }
  }

  return json({ success: true, cut_code, analyses: results });
}


// =============================================================================
// Opus 4.7 API ?몄텧 ?ы띁
// =============================================================================

async function callOpus47Vision(env, { systemPrompt, imageBase64, mediaType, userPrompt }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 誘몄꽕?');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7-20250415',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64
            }
          },
          { type: 'text', text: userPrompt }
        ]
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(`Opus 4.7 Error: ${data.error.message}`);

  return {
    result: data.content?.[0]?.text || '',
    usage: data.usage,
    cost: calculateCost(data.usage, 'opus-4-7')
  };
}

async function callOpus47Text(env, { systemPrompt, userPrompt }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 誘몄꽕?');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7-20250415',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: userPrompt
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(`Opus 4.7 Error: ${data.error.message}`);

  return {
    result: data.content?.[0]?.text || '',
    usage: data.usage,
    cost: calculateCost(data.usage, 'opus-4-7')
  };
}

function calculateCost(usage, model) {
  if (!usage) return 0;
  // Opus 4.7 pricing (estimated)
  const rates = {
    'opus-4-7': { input: 15 / 1e6, output: 75 / 1e6 },
    'sonnet-4-6': { input: 3 / 1e6, output: 15 / 1e6 }
  };
  const r = rates[model] || rates['opus-4-7'];
  return (usage.input_tokens || 0) * r.input + (usage.output_tokens || 0) * r.output;
}


// =============================================================================
// System Prompts for Opus 4.7 Analysis
// =============================================================================

const STORYBOARD_ANALYSIS_PROMPT = `?뱀떊? 3D ?좊땲硫붿씠???꾨줈?뺤뀡 ?꾨Ц ?ㅽ넗由щ낫??遺꾩꽍媛?낅땲??
TV?쒕━利?'?곕낫?? (26遺?? 濡쒕큸 ?≪뀡 3D ?좊땲硫붿씠?????ㅽ넗由щ낫?쒕? 遺꾩꽍?⑸땲'?

遺꾩꽍 寃곌낵瑜?諛섎뱶???ㅼ쓬 JSON ?뺤떇?쇰줈 異쒕젰?섏꽭??
{
  "shot_type": "CU/MS/WS/ECU/OTS/2SHOT ??,
  "camera_angle": "Eye Level/High Angle/Low Angle/Dutch/Bird's Eye ??,
  "composition": "?쇰텇踰??移?由щ뵫?쇱씤/?꾨젅?꾩씤?꾨젅????,
  "characters": [{"name": "罹먮┃?곕챸", "position": "?붾㈃ ???꾩튂", "expression": "?쒖젙/媛먯젙"}],
  "directing_intent": "??而룹쓽 ?곗텧 ?섎룄 (1-2臾몄옣)",
  "action_description": "??而룹뿉???쇱뼱?섎뒗 ?≪뀡 (1-2臾몄옣)",
  "mood_atmosphere": "遺꾩쐞湲???,
  "continuity_notes": "而⑦떚?댄떚 二쇱쓽?ы빆",
  "seedance_visual_keywords": ["?ㅼ썙??", "?ㅼ썙??", ...],
  "quality_score": 1-10,
  "improvement_suggestions": ["?쒖븞1", "?쒖븞2"]
}`;

const GUIDE_ANALYSIS_PROMPT = `?뱀떊? 3D ?좊땲硫붿씠???곗텧媛?대뱶 遺꾩꽍 ?꾨Ц媛?낅땲??
TV?쒕━利?'?곕낫?? (濡쒕큸 ?≪뀡 3D ?좊땲硫붿씠?????곗텧媛?대뱶瑜?遺꾩꽍?⑸땲'?

遺꾩꽍 寃곌낵瑜?諛섎뱶???ㅼ쓬 JSON ?뺤떇?쇰줈 異쒕젰?섏꽭??
{
  "camera_move": "Pan/Tilt/Dolly/Crane/Handheld/Zoom/Static ??,
  "camera_start": "?쒖옉 ?ъ????ㅻ챸",
  "camera_end": "醫낅즺 ?ъ????ㅻ챸",
  "camera_easing": "Linear/EaseIn/EaseOut/EaseInOut/Smooth ??,
  "cut_duration_sec": ?レ옄,
  "key_moments": [{"frame": "?꾨젅???쒓컙", "description": "?ㅻ챸"}],
  "rhythm": "鍮좊쫫/蹂댄넻/?먮┝/媛??媛먯냽",
  "directing_notes": "?곗텧 ?섎룄? ?밴린?ы빆",
  "transition_in": "?댁쟾 而룹뿉???섏뼱?ㅻ뒗 諛⑹떇",
  "transition_out": "?ㅼ쓬 而룹쑝濡??섏뼱媛??諛⑹떇",
  "audio_cue": "?ъ슫???뚯븙 ??(?덈떎硫?",
  "seedance_motion_keywords": ["紐⑥뀡?ㅼ썙??", "紐⑥뀡?ㅼ썙??"]
}`;

const PLAYBLAST_ANALYSIS_PROMPT = `?뱀떊? Disney 12踰뺤튃 湲곕컲 3D 罹먮┃???좊땲硫붿씠??遺꾩꽍 ?꾨Ц媛?낅땲??
TV?쒕━利?'?곕낫?? (濡쒕큸 ?≪뀡 3D ?좊땲硫붿씠????Maya ?뚮젅?대툝?쇱뒪?몃? 遺꾩꽍?⑸땲'?

遺꾩꽍 寃곌낵瑜?諛섎뱶???ㅼ쓬 JSON ?뺤떇?쇰줈 異쒕젰?섏꽭??
{
  "disney_12_principles": {
    "squash_stretch": {"applied": true/false, "score": 1-10, "note": ""},
    "anticipation": {"applied": true/false, "score": 1-10, "note": ""},
    "staging": {"applied": true/false, "score": 1-10, "note": ""},
    "straight_ahead_pose": {"applied": true/false, "score": 1-10, "note": ""},
    "follow_through": {"applied": true/false, "score": 1-10, "note": ""},
    "slow_in_out": {"applied": true/false, "score": 1-10, "note": ""},
    "arc": {"applied": true/false, "score": 1-10, "note": ""},
    "secondary_action": {"applied": true/false, "score": 1-10, "note": ""},
    "timing": {"applied": true/false, "score": 1-10, "note": ""},
    "exaggeration": {"applied": true/false, "score": 1-10, "note": ""},
    "solid_drawing": {"applied": true/false, "score": 1-10, "note": ""},
    "appeal": {"applied": true/false, "score": 1-10, "note": ""}
  },
  "total_score": ?レ옄,
  "pose_keys": ["二쇱슂 ?ъ쫰 ?ㅻ챸1", "二쇱슂 ?ъ쫰 ?ㅻ챸2"],
  "weight_shift": "?⑥씠???쒗봽???덉쭏 ?됯?",
  "arc_quality": "?꾪겕 ?덉쭏 ?됯?",
  "emotion_delivery": "媛먯젙 ?꾨떖 ?됯?",
  "improvement_suggestions": ["媛쒖꽑?쒖븞1", "媛쒖꽑?쒖븞2"],
  "seedance_animation_keywords": ["?좊땲硫붿씠?섑궎?뚮뱶1", "?좊땲硫붿씠?섑궎?뚮뱶2"]
}`;

const COMBINED_ANALYSIS_PROMPT = `?뱀떊? 3D ?좊땲硫붿씠???꾨줈?뺤뀡 珥앷큵 遺꾩꽍媛?낅땲??
?ㅽ넗由щ낫?? ?곗텧媛?대뱶, ?좊땲硫붿씠???뚮젅?대툝?쇱뒪?? 遺꾩꽍 寃곌낵瑜?醫낇빀?⑸땲??

媛??뚰듃蹂?遺꾩꽍??醫낇빀?섏뿬 ?ㅼ쓬 JSON ?뺤떇?쇰줈 理쒖쥌 遺꾩꽍???묒꽦?섏꽭??
{
  "cut_summary": "??而룹쓽 醫낇빀 ?붿빟 (2-3臾몄옣)",
  "production_readiness": "production_ready / needs_revision / major_revision",
  "readiness_score": 1-10,
  "storyboard_to_animation_match": "?ㅽ넗由щ낫?쒖? ?좊땲硫붿씠???쇱튂???됯?",
  "guide_compliance": "?곗텧媛?대뱶 以?섎룄 ?됯?",
  "continuity_issues": ["而⑦떚?댁씠??臾몄젣??],
  "final_notes": "理쒖쥌 肄붾찘??,
  "seedance_prompt_draft": "Seedance 2.0 ?꾨＼?꾪듃 珥덉븞 (?곸뼱)",
  "seedance_params": {
    "mode": "omni_reference",
    "resolution": "1280x720",
    "duration": "5s",
    "motion_strength": "medium"
  }
}`;


// =============================================================================
// 3. 遺꾩꽍 寃곌낵 議고쉶
// =============================================================================

async function analysisGetResult(request, env) {
  const url = new URL(request.url);
  const cutCode = url.searchParams.get('cut_code');
  const analysisType = url.searchParams.get('type'); // optional filter

  if (!cutCode) return json({ error: 'cut_code ?꾩닔' }, 400);

  let query = `SELECT * FROM analysis_results WHERE cut_code = ?`;
  const params = [cutCode];
  if (analysisType) {
    query += ` AND analysis_type = ?`;
    params.push(analysisType);
  }
  query += ` ORDER BY analysis_type, version DESC`;

  const results = await env.DB.prepare(query).bind(...params).all();
  return json({ cut_code: cutCode, analyses: results.results || [] });
}


// =============================================================================
// 4. 遺꾩꽍 ??Obsidian 留덊겕?ㅼ슫
// =============================================================================

async function analysisToObsidian(request, env, user) {
  const body = await request.json();
  const { cut_code, episode_id } = body;

  let cutCodes = [];
  if (cut_code) {
    cutCodes = [cut_code];
  } else if (episode_id) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT cut_code FROM analysis_results WHERE episode_id = ?`
    ).bind(episode_id).all();
    cutCodes = (rows.results || []).map(r => r.cut_code);
  } else {
    return json({ error: 'cut_code ?먮뒗 episode_id ?꾩닔' }, 400);
  }

  const generated = [];

  for (const cc of cutCodes) {
    // 理쒖떊 踰꾩쟾 遺꾩꽍 寃곌낵 媛?몄삤湲?
    const analyses = await env.DB.prepare(`
      SELECT ar.* FROM analysis_results ar
      INNER JOIN (
        SELECT cut_code, analysis_type, MAX(version) as max_ver
        FROM analysis_results
        WHERE cut_code = ?
        GROUP BY cut_code, analysis_type
      ) latest ON ar.cut_code = latest.cut_code
        AND ar.analysis_type = latest.analysis_type
        AND ar.version = latest.max_ver
    `).bind(cc).all();

    if (!analyses.results?.length) continue;

    // ?뚯씪 ?뺣낫
    const files = await env.DB.prepare(
      `SELECT * FROM analysis_files WHERE cut_code = ?`
    ).bind(cc).all();

    // 留덊겕?ㅼ슫 ?앹꽦
    const md = generateCutMarkdown(cc, analyses.results, files.results || []);

    // R2 ???(Obsidian vault 寃쎈줈)
    const epId = analyses.results[0].episode_id;
    const r2Path = `obsidian-vault/??${epId}/${cc}.md`;
    await env.ASSETS.put(r2Path, md, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' }
    });

    // 濡쒓렇 湲곕줉
    const logId = `OL_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await env.DB.prepare(`
      INSERT INTO analysis_obsidian_log (id, cut_code, episode_id, r2_path)
      VALUES (?, ?, ?, ?)
    `).bind(logId, cc, epId, r2Path).run();

    generated.push({ cut_code: cc, r2_path: r2Path });
  }

  return json({ success: true, generated });
}


// =============================================================================
// 留덊겕?ㅼ슫 ?앹꽦湲?// =============================================================================

function generateCutMarkdown(cutCode, analyses, files) {
  const epId = cutCode.split('_')[0] || 'EP01';
  const cutNum = cutCode.split('_').pop() || cutCode;
  const today = new Date().toISOString().slice(0, 10);

  // 遺꾩꽍 寃곌낵 ?뚯떛
  let sbAnalysis = {}, guideAnalysis = {}, pbAnalysis = {}, combinedAnalysis = {};
  for (const a of analyses) {
    try {
      const parsed = typeof a.result_json === 'string' ? JSON.parse(a.result_json) : a.result_json;
      // result_json??JSON string?대㈃ ?쒕쾲 ???뚯떛
      const data = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      switch (a.analysis_type) {
        case 'storyboard': sbAnalysis = data; break;
        case 'guide': guideAnalysis = data; break;
        case 'playblast': pbAnalysis = data; break;
        case 'combined': combinedAnalysis = data; break;
      }
    } catch (e) { /* ?뚯떛 ?ㅽ뙣 臾댁떆 */ }
  }

  // ?뚯씪 寃쎈줈
  const sbFile = files.find(f => f.file_type === 'storyboard');
  const guideFile = files.find(f => f.file_type === 'guide');
  const pbFile = files.find(f => f.file_type === 'playblast');

  let md = `---
type: cut
cut_code: "${cutCode}"
episode: "[[${epId}]]"
project: "[[?곕낫???쒖쫵1]]"
status: "${combinedAnalysis.production_readiness || 'analyzed'}"
readiness_score: ${combinedAnalysis.readiness_score || 0}
analyzed_by: opus-4.7
analysis_date: "${today}"
tags: [cut, ${epId}, analyzed]
---

# ${cutCode}

| ??ぉ | 媛?|
|------|-----|
| ?먰뵾?뚮뱶 | [[${epId}]] |
| 而?踰덊샇 | ${cutNum} |
| 以鍮꾨룄 | ${combinedAnalysis.readiness_score || '-'}/10 |
| ?곹깭 | ${combinedAnalysis.production_readiness || 'analyzed'} |
| 遺꾩꽍??| ${today} |

`;

  // 醫낇빀 ?붿빟
  if (combinedAnalysis.cut_summary) {
    md += `## 醫낇빀 ?붿빟\n> ${combinedAnalysis.cut_summary}\n\n`;
  }

  // ?ㅽ넗由щ낫??遺꾩꽍
  md += `## ?ㅽ넗由щ낫??遺꾩꽍\n`;
  if (Object.keys(sbAnalysis).length) {
    md += `
### 援щ룄
- **?????*: ${sbAnalysis.shot_type || '-'}
- **移대찓???듦?**: ${sbAnalysis.camera_angle || '-'}
- **援щ룄 踰뺤튃**: ${sbAnalysis.composition || '-'}

### 罹먮┃??諛곗튂
`;
    if (sbAnalysis.characters?.length) {
      for (const c of sbAnalysis.characters) {
        md += `- **${c.name}**: ${c.position} / ${c.expression}\n`;
      }
    }
    md += `
### ?곗텧 ?섎룄
> ${sbAnalysis.directing_intent || '-'}

### ?≪뀡
> ${sbAnalysis.action_description || '-'}

### 遺꾩쐞湲?> ${sbAnalysis.mood_atmosphere || '-'}
`;
    if (sbAnalysis.improvement_suggestions?.length) {
      md += `\n### 媛쒖꽑 ?쒖븞\n`;
      for (const s of sbAnalysis.improvement_suggestions) {
        md += `- ${s}\n`;
      }
    }
  } else {
    md += `> 遺꾩꽍 ?湲곗쨷\n`;
  }
  if (sbFile) {
    md += `\n![[${sbFile.filename || cutCode + '_storyboard.png'}]]\n`;
  }

  // ?곗텧媛?대뱶 遺꾩꽍
  md += `\n## ?곗텧媛?대뱶 遺꾩꽍\n`;
  if (Object.keys(guideAnalysis).length) {
    md += `
### 移대찓???뚰겕
- **移대찓??臾대튃**: ${guideAnalysis.camera_move || '-'}
- **?쒖옉 ?ъ???*: ${guideAnalysis.camera_start || '-'}
- **醫낅즺 ?ъ???*: ${guideAnalysis.camera_end || '-'}
- **?댁쭠**: ${guideAnalysis.camera_easing || '-'}

### ??대컢
- **而?湲몄씠**: ${guideAnalysis.cut_duration_sec || '-'} sec
- **由щ벉**: ${guideAnalysis.rhythm || '-'}

### ??紐⑤㉫??`;
    if (guideAnalysis.key_moments?.length) {
      for (const km of guideAnalysis.key_moments) {
        md += `- [${km.frame}] ${km.description}\n`;
      }
    }
    md += `\n### ?곗텧 ?명듃\n> ${guideAnalysis.directing_notes || '-'}\n`;
  } else {
    md += `> 遺꾩꽍 ?湲곗쨷\n`;
  }

  // ?뚮젅?대툝?쇱뒪??(Disney 12踰뺤튃)
  md += `\n## ?좊땲硫붿씠??遺꾩꽍 (Disney 12踰뺤튃)\n`;
  if (pbAnalysis.disney_12_principles) {
    const d12 = pbAnalysis.disney_12_principles;
    md += `| 踰뺤튃 | ?먯닔 | ?명듃 |\n|------|------|------|\n`;
    const principles = [
      ['Squash & Stretch', d12.squash_stretch],
      ['Anticipation', d12.anticipation],
      ['Staging', d12.staging],
      ['Straight Ahead / Pose to Pose', d12.straight_ahead_pose],
      ['Follow Through / Overlapping', d12.follow_through],
      ['Slow In / Slow Out', d12.slow_in_out],
      ['Arc', d12.arc],
      ['Secondary Action', d12.secondary_action],
      ['Timing', d12.timing],
      ['Exaggeration', d12.exaggeration],
      ['Solid Drawing', d12.solid_drawing],
      ['Appeal', d12.appeal]
    ];
    for (const [name, data] of principles) {
      if (data) {
        md += `| ${name} | ${data.score || '-'}/10 | ${data.note || ''} |\n`;
      }
    }
    md += `\n**珥앹젏**: ${pbAnalysis.total_score || '-'}/120\n`;

    if (pbAnalysis.improvement_suggestions?.length) {
      md += `\n### 媛쒖꽑 ?쒖븞\n`;
      for (const s of pbAnalysis.improvement_suggestions) {
        md += `- ${s}\n`;
      }
    }
  } else {
    md += `> 遺꾩꽍 ?湲곗쨷\n`;
  }

  // Seedance ?꾨＼?꾪듃
  md += `\n## Seedance 2.0 ?꾨＼?꾪듃\n`;
  if (combinedAnalysis.seedance_prompt_draft) {
    md += `\`\`\`\n${combinedAnalysis.seedance_prompt_draft}\n\`\`\`\n`;
    if (combinedAnalysis.seedance_params) {
      const sp = combinedAnalysis.seedance_params;
      md += `\n| ?뚮씪誘명꽣 | 媛?|\n|----------|-----|\n`;
      md += `| 紐⑤뱶 | ${sp.mode || '-'} |\n`;
      md += `| ?댁긽??| ${sp.resolution || '-'} |\n`;
      md += `| 湲몄씠 | ${sp.duration || '-'} |\n`;
      md += `| 紐⑥뀡 媛뺣룄 | ${sp.motion_strength || '-'} |\n`;
    }
  } else {
    md += `> 遺꾩꽍 ?꾨즺 ???먮룞 ?앹꽦\n`;
  }

  // ?곌껐 ?명듃
  md += `\n## ?곌껐\n`;
  md += `- ?먰뵾?뚮뱶: [[${epId}]]\n`;
  md += `- ?꾨줈?앺듃: [[?곕낫???쒖쫵1]]\n`;

  // 踰꾩쟾 ?덉뒪?좊━
  md += `\n## 遺꾩꽍 ?덉뒪?좊━\n`;
  md += `| ?좎쭨 | ???| 紐⑤뜽 |\n|------|------|------|\n`;
  for (const a of analyses) {
    md += `| ${new Date(a.created_at * 1000).toISOString().slice(0, 10)} | ${a.analysis_type} | ${a.model} |\n`;
  }

  return md;
}


// =============================================================================
// 5. 諛곗튂 遺꾩꽍
// =============================================================================

async function analysisBatch(request, env, user) {
  const body = await request.json();
  const { episode_id, file_types = ['storyboard'] } = body;

  if (!episode_id) return json({ error: 'episode_id ?꾩닔' }, 400);

  // ?대떦 ?먰뵾?뚮뱶??紐⑤뱺 而??뚯씪 議고쉶
  const files = await env.DB.prepare(
    `SELECT DISTINCT cut_code FROM analysis_files WHERE episode_id = ? AND file_type IN (${file_types.map(() => '?').join(',')})`
  ).bind(episode_id, ...file_types).all();

  if (!files.results?.length) {
    return json({ error: `${episode_id}???낅줈?쒕맂 ?뚯씪 ?놁쓬` }, 404);
  }

  // 諛곗튂 ?묒뾽 ID
  const batchId = `BATCH_${Date.now()}`;
  const cutCodes = files.results.map(r => r.cut_code);

  // 二쇱쓽: Worker ?ㅽ뻾?쒓컙 ?쒗븳(30珥??쇰줈 ?명빐 ?꾩껜 ?먰뵾?뚮뱶 ?쒕쾲??遺덇?
  // 泥?5而룸쭔 利됱떆 ?ㅽ뻾, ?섎㉧吏???먯엵
  const immediate = cutCodes.slice(0, 5);
  const queued = cutCodes.slice(5);

  const results = [];
  for (const cc of immediate) {
    try {
      const fakeReq = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({ cut_code: cc, file_types })
      });
      const res = await analysisRunOpus(fakeReq, env, user);
      const resBody = await res.json();
      results.push({ cut_code: cc, status: 'completed', ...resBody });
    } catch (e) {
      results.push({ cut_code: cc, status: 'error', error: e.message });
    }
  }

  return json({
    batch_id: batchId,
    episode_id,
    total_cuts: cutCodes.length,
    completed: results.length,
    queued: queued.length,
    results,
    queued_cuts: queued,
    note: queued.length > 0 ?
      `Worker 30珥??쒗븳?쇰줈 ${queued.length}而룹? 異붽? ?몄텧 ?꾩슂. /api/analysis/analyze濡?媛쒕퀎 ?ㅽ뻾?섏꽭??` :
      'All cuts analyzed'
  });
}


// =============================================================================
// 6. 遺꾩꽍 ?덉뒪?좊━
// =============================================================================

async function analysisHistory(request, env) {
  const url = new URL(request.url);
  const episodeId = url.searchParams.get('episode_id');
  const limit = parseInt(url.searchParams.get('limit') || '50');

  let query, params;
  if (episodeId) {
    query = `SELECT * FROM analysis_results WHERE episode_id = ? ORDER BY created_at DESC LIMIT ?`;
    params = [episodeId, limit];
  } else {
    query = `SELECT * FROM analysis_results ORDER BY created_at DESC LIMIT ?`;
    params = [limit];
  }

  const results = await env.DB.prepare(query).bind(...params).all();
  return json({ history: results.results || [] });
}


// =============================================================================
// 7. Seedance ?꾨＼?꾪듃 ?앹꽦
// =============================================================================

async function analysisGeneratePrompt(request, env, user) {
  const body = await request.json();
  const { cut_code } = body;

  if (!cut_code) return json({ error: 'cut_code ?꾩닔' }, 400);

  // 紐⑤뱺 遺꾩꽍 寃곌낵 ?섏쭛
  const analyses = await env.DB.prepare(`
    SELECT ar.* FROM analysis_results ar
    INNER JOIN (
      SELECT cut_code, analysis_type, MAX(version) as max_ver
      FROM analysis_results WHERE cut_code = ?
      GROUP BY cut_code, analysis_type
    ) latest ON ar.cut_code = latest.cut_code
      AND ar.analysis_type = latest.analysis_type
      AND ar.version = latest.max_ver
  `).bind(cut_code).all();

  if (!analyses.results?.length) {
    return json({ error: `${cut_code} 遺꾩꽍 寃곌낵 ?놁쓬. 癒쇱? /api/analysis/analyze ?ㅽ뻾` }, 404);
  }

  const analysisContext = analyses.results.map(a =>
    `[${a.analysis_type}]: ${a.result_json}`
  ).join('\n\n');

  const result = await callOpus47Text(env, {
    systemPrompt: SEEDANCE_PROMPT_GENERATION,
    userPrompt: `而?肄붾뱶: ${cut_code}\n\n遺꾩꽍 寃곌낵:\n${analysisContext}\n\n??遺꾩꽍??諛뷀깢?쇰줈 Seedance 2.0 理쒖쥌 ?꾨＼?꾪듃瑜??앹꽦?댁＜?몄슂.`
  });

  return json({
    cut_code,
    prompt: result.result,
    usage: result.usage,
    cost: result.cost
  });
}

const SEEDANCE_PROMPT_GENERATION = `?뱀떊? Seedance 2.0 AI ?곸긽 ?앹꽦 ?꾨＼?꾪듃 ?꾨Ц媛?낅땲??
?ㅽ넗由щ낫???곗텧媛?대뱶/?좊땲硫붿씠??遺꾩꽍 寃곌낵瑜?諛뷀깢?쇰줈 理쒖쟻??Seedance 2.0 ?꾨＼?꾪듃瑜??앹꽦?⑸땲??

洹쒖튃:
1. ?꾨＼?꾪듃???곸뼱濡??묒꽦
2. Seedance 2.0 omni_reference 紐⑤뱶 (Maya playblast瑜??덊띁?곗뒪濡??ъ슜)
3. 移대찓??臾대튃? 遺꾩꽍???곗텧媛?대뱶瑜??뺥솗??諛섏쁺
4. Disney 12踰뺤튃 遺꾩꽍?먯꽌 遺議깊븳 遺遺꾩쓣 ?꾨＼?꾪듃濡?蹂닿컯
5. 罹먮┃??媛먯젙怨??≪뀡??援ъ껜?곸쑝濡?臾섏궗

異쒕젰 ?뺤떇 (JSON):
{
  "prompt": "Seedance 2.0 ?꾨＼?꾪듃 (?곸뼱, 200?⑥뼱 ?대궡)",
  "negative_prompt": "?ㅺ굅?곕툕 ?꾨＼?꾪듃",
  "params": {
    "mode": "omni_reference",
    "resolution": "1280x720",
    "duration": "5s",
    "fps": 24,
    "motion_strength": "medium/high/low",
    "style_strength": 0.7,
    "reference_strength": 0.8
  },
  "notes_ko": "?쒓뎅??李멸퀬 ?명듃"
}`;

// ===== AI LOG API ??/api/ai-log/* =====

async function ensureAILogTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ai_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default',
      episode TEXT,
      shot TEXT,
      ai_tool TEXT,
      template_type TEXT,
      status TEXT DEFAULT 'draft',
      r2_key TEXT NOT NULL,
      result_json TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `).run();
}

function sanitizeAILogPathPart(value, fallback) {
  const raw = String(value || fallback || 'untitled').trim();
  return raw
    .replace(/[\\/:*?"<>|#%{}[\]^~`]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 80) || fallback || 'untitled';
}

function escapeYamlValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function buildAILogMarkdown(log) {
  const result = typeof log.result_json === 'string'
    ? safeJsonParse(log.result_json, {})
    : (log.result_json || {});
  const createdAt = log.created_at || new Date().toISOString();
  const template = log.template_type || 'shot-ai-log';
  const titleParts = [log.episode, log.shot, log.ai_tool].filter(Boolean);
  const title = titleParts.length ? titleParts.join(' ') : log.id;

  return `---
id: "${escapeYamlValue(log.id)}"
project: "${escapeYamlValue(log.project_id || 'default')}"
episode: "${escapeYamlValue(log.episode || '')}"
shot: "${escapeYamlValue(log.shot || '')}"
ai_tool: "${escapeYamlValue(log.ai_tool || '')}"
template_type: "${escapeYamlValue(template)}"
status: "${escapeYamlValue(log.status || 'draft')}"
created_at: "${escapeYamlValue(createdAt)}"
updated_at: "${escapeYamlValue(log.updated_at || createdAt)}"
---

# ${title}

## Summary

${result.summary || result.description || 'AI result saved for production review.'}

## Result JSON

\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`

## Review

- Decision:
- Notes:
- Next action:
`;
}

async function handleAILogAPI(path, request, env) {
  const method = request.method;
  const user = await authenticateAny(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if (!env.ASSETS) return json({ error: 'R2 ASSETS binding is not configured' }, 500);

  const db = env.DB;
  await ensureAILogTables(db);
  const url = new URL(request.url);

  if (path === '/api/ai-log/save' && method === 'POST') {
    const body = await request.json();
    const now = new Date().toISOString();
    const id = body.id || crypto.randomUUID();
    const projectId = body.project || body.project_id || 'default';
    const episode = body.episode || '';
    const shot = body.shot || body.shot_id || '';
    const aiTool = body.ai_tool || body.tool || 'unknown-ai-tool';
    const templateType = body.template_type || 'shot-ai-log';
    const status = body.status || 'draft';
    const resultJson = JSON.stringify(body.result_json || body.result || {}, null, 2);

    const projectPart = sanitizeAILogPathPart(projectId, 'default');
    const episodePart = sanitizeAILogPathPart(episode, 'episode');
    const shotPart = sanitizeAILogPathPart(shot || id, id);
    const r2Key = body.r2_key || `obsidian-logs/${projectPart}/shots/${episodePart}_${shotPart}_ai-log.md`;

    const log = {
      id,
      project_id: projectId,
      episode,
      shot,
      ai_tool: aiTool,
      template_type: templateType,
      status,
      r2_key: r2Key,
      result_json: resultJson,
      created_by: user.id || user.email || 'unknown',
      created_at: now,
      updated_at: now
    };
    const markdown = body.markdown || buildAILogMarkdown(log);

    await env.ASSETS.put(r2Key, markdown, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: {
        project_id: projectId,
        template_type: templateType,
        ai_tool: aiTool,
        status
      }
    });

    await db.prepare(`
      INSERT OR REPLACE INTO ai_logs
      (id, project_id, episode, shot, ai_tool, template_type, status, r2_key, result_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM ai_logs WHERE id = ?), ?), ?)
    `).bind(
      id, projectId, episode, shot, aiTool, templateType, status, r2Key,
      resultJson, log.created_by, id, now, now
    ).run();

    return json({ success: true, id, r2_key: r2Key, markdown });
  }

  if (path === '/api/ai-log/list' && method === 'GET') {
    const projectId = url.searchParams.get('project') || 'default';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 300);
    const { results } = await db.prepare(
      'SELECT * FROM ai_logs WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?'
    ).bind(projectId, limit).all();
    return json({ success: true, logs: results || [] });
  }

  if (path === '/api/ai-log/markdown' && method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key || !key.startsWith('obsidian-logs/')) return json({ error: 'Valid key is required' }, 400);
    const object = await env.ASSETS.get(key);
    if (!object) return json({ error: 'Not found' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }

  return json({ error: 'Not found' }, 404);
}

// ===== VIDEO EDIT AI API ??/api/video-edit/* =====
async function ensureVideoEditTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS video_edit_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default',
      episode TEXT,
      shot_id TEXT,
      prompt TEXT,
      sources_json TEXT,
      options_json TEXT,
      status TEXT DEFAULT 'pending',
      result_json TEXT,
      markdown_log TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `).run();
}

function safeJsonParse(text, fallback) {
  try {
    if (text === null || text === undefined || text === '') return fallback;
    return JSON.parse(text);
  } catch(e) {
    return fallback;
  }
}

function buildVideoEditMarkdown(job) {
  const sources = safeJsonParse(job.sources_json, []);
  const options = safeJsonParse(job.options_json, {});
  const result = safeJsonParse(job.result_json, null);
  const sourceLines = Array.isArray(sources) && sources.length
    ? sources.map(s => `- ${s.filename || s.key || 'source'}: ${s.url || s.r2_key || s.key || ''}`).join('\n')
    : '- ?놁쓬';

  return `# ${job.id} Video Edit AI Log

project: ${job.project_id || 'default'}
episode: ${job.episode || ''}
shot: ${job.shot_id || ''}
status: ${job.status || 'pending'}
created: ${job.created_at || ''}
updated: ${job.updated_at || ''}

## Source

${sourceLines}

## Edit Request

${job.prompt || ''}

## Options

\`\`\`json
${JSON.stringify(options, null, 2)}
\`\`\`

## Result

\`\`\`json
${JSON.stringify(result || {}, null, 2)}
\`\`\`

## Human Review

- reviewer:
- decision:
- retake_reason:
- next_action:

## Lessons

- worked:
- failed:
- prompt_fix:
- tags: video-edit, ai-pipeline
`;
}

async function handleVideoEditAPI(path, request, env) {
  const user = await authenticateAny(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const db = env.DB;
  await ensureVideoEditTables(db);
  const method = request.method;
  const url = new URL(request.url);
  const parts = path.split('/').filter(Boolean);
  const id = parts[3];
  const sub = parts[4];

  if (path === '/api/video-edit/jobs' && method === 'GET') {
    const projectId = url.searchParams.get('project') || 'default';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const rows = await db.prepare(
      `SELECT * FROM video_edit_jobs
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(projectId, limit).all();
    return json({ success: true, jobs: rows.results || [] });
  }

  if (path === '/api/video-edit/jobs' && method === 'POST') {
    const body = await request.json();
    const jobId = body.id || ('VE_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    const now = new Date().toISOString();
    const job = {
      id: jobId,
      project_id: body.project_id || 'default',
      episode: body.episode || '',
      shot_id: body.shot_id || body.shot || '',
      prompt: body.prompt || '',
      sources_json: JSON.stringify(body.sources || []),
      options_json: JSON.stringify(body.options || {}),
      status: body.status || 'pending',
      result_json: JSON.stringify(body.result || null),
      created_by: user.id || user.email || user.name || 'unknown',
      created_at: now,
      updated_at: now,
      completed_at: body.completed_at || null
    };
    const markdown = buildVideoEditMarkdown(job);
    await db.prepare(
      `INSERT INTO video_edit_jobs
       (id, project_id, episode, shot_id, prompt, sources_json, options_json, status, result_json, markdown_log, created_by, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      job.id, job.project_id, job.episode, job.shot_id, job.prompt, job.sources_json,
      job.options_json, job.status, job.result_json, markdown, job.created_by,
      job.created_at, job.updated_at, job.completed_at
    ).run();
    return json({ success: true, job: { ...job, markdown_log: markdown } });
  }

  if (id && sub === 'markdown' && method === 'GET') {
    const job = await db.prepare('SELECT * FROM video_edit_jobs WHERE id = ?').bind(id).first();
    if (!job) return json({ error: 'Not found' }, 404);
    const markdown = job.markdown_log || buildVideoEditMarkdown(job);
    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }

  if (id && !sub && method === 'GET') {
    const job = await db.prepare('SELECT * FROM video_edit_jobs WHERE id = ?').bind(id).first();
    if (!job) return json({ error: 'Not found' }, 404);
    return json({ success: true, job });
  }

  if (id && !sub && (method === 'PATCH' || method === 'PUT')) {
    const body = await request.json();
    const existing = await db.prepare('SELECT * FROM video_edit_jobs WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'Not found' }, 404);
    const updated = {
      ...existing,
      project_id: body.project_id ?? existing.project_id,
      episode: body.episode ?? existing.episode,
      shot_id: (body.shot_id ?? body.shot) ?? existing.shot_id,
      prompt: body.prompt ?? existing.prompt,
      sources_json: body.sources ? JSON.stringify(body.sources) : existing.sources_json,
      options_json: body.options ? JSON.stringify(body.options) : existing.options_json,
      status: body.status ?? existing.status,
      result_json: body.result ? JSON.stringify(body.result) : existing.result_json,
      updated_at: new Date().toISOString(),
      completed_at: body.completed_at ?? existing.completed_at
    };
    if (updated.status === 'done' && !updated.completed_at) updated.completed_at = updated.updated_at;
    updated.markdown_log = buildVideoEditMarkdown(updated);

    await db.prepare(
      `UPDATE video_edit_jobs
       SET project_id=?, episode=?, shot_id=?, prompt=?, sources_json=?, options_json=?,
           status=?, result_json=?, markdown_log=?, updated_at=?, completed_at=?
       WHERE id=?`
    ).bind(
      updated.project_id, updated.episode, updated.shot_id, updated.prompt,
      updated.sources_json, updated.options_json, updated.status, updated.result_json,
      updated.markdown_log, updated.updated_at, updated.completed_at, id
    ).run();
    return json({ success: true, job: updated });
  }

  if (id && !sub && method === 'DELETE') {
    const role = user.role || 'member';
    if (role !== 'admin' && role !== 'pd') return json({ error: 'Admin/PD only' }, 403);
    await db.prepare('DELETE FROM video_edit_jobs WHERE id=?').bind(id).run();
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}

// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// FEEDBACK LOOP API ??/api/feedback/*
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
async function handleFeedbackAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  const user = await authenticateAny(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const isAdminOrPd = user.role === 'admin' || user.role === 'pd';

  // ?? GET /api/feedback/stats ?????????????????????????????????
  if (path === '/api/feedback/stats' && method === 'GET') {
    const total = await db.prepare('SELECT COUNT(*) as c FROM feedback').first();
    const byStatus = await db.prepare(
      'SELECT status, COUNT(*) as c FROM feedback GROUP BY status'
    ).all();
    const byCategory = await db.prepare(
      'SELECT category, COUNT(*) as c FROM feedback GROUP BY category'
    ).all();
    const byPriority = await db.prepare(
      'SELECT priority, COUNT(*) as c FROM feedback GROUP BY priority'
    ).all();
    return json({
      success: true,
      total: total?.c || 0,
      by_status: byStatus.results,
      by_category: byCategory.results,
      by_priority: byPriority.results,
    });
  }

  // ?? POST /api/feedback/analyze (stub) ???????????????????????
  if (path === '/api/feedback/analyze' && method === 'POST') {
    if (!isAdminOrPd) return json({ error: 'Forbidden' }, 403);
    return json({ success: true, message: 'AI 遺꾩꽍 湲곕뒫? 異뷀썑 援ы쁽 ?덉젙?낅땲??' });
  }

  // ?? POST /api/feedback ???쇰뱶諛??앹꽦 ???????????????????????
  if (path === '/api/feedback' && method === 'POST') {
    const body = await request.json();
    if (!body.title) return json({ error: 'title is required' }, 400);
    const result = await db.prepare(
      `INSERT INTO feedback (member_id, member_name, member_role, page, category, priority, title, body, screenshot_r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.id || null,
      user.name || user.email || null,
      user.role || null,
      body.page || null,
      body.category || 'general',
      body.priority || 'normal',
      body.title,
      body.body || null,
      body.screenshot_r2_key || null
    ).run();
    return json({ success: true, id: result.meta?.last_row_id });
  }

  // ?? GET /api/feedback ??紐⑸줉 ????????????????????????????????
  if (path === '/api/feedback' && method === 'GET') {
    const url = new URL(request.url);
    const status   = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const page     = url.searchParams.get('page');
    const mine     = url.searchParams.get('mine');

    let q = 'SELECT * FROM feedback WHERE 1=1';
    const params = [];
    if (status)   { q += ' AND status=?';   params.push(status); }
    if (category) { q += ' AND category=?'; params.push(category); }
    if (page)     { q += ' AND page=?';     params.push(page); }
    if (mine === '1') { q += ' AND member_id=?'; params.push(user.id); }
    q += ' ORDER BY created_at DESC LIMIT 200';

    const rows = await db.prepare(q).bind(...params).all();
    return json({ success: true, items: rows.results });
  }

  // ?? ?뚮씪誘명꽣 ?쇱슦???뚯떛 ????????????????????????????????????
  const idMatch      = path.match(/^\/api\/feedback\/(\d+)$/);
  const statusMatch  = path.match(/^\/api\/feedback\/(\d+)\/status$/);
  const commentMatch = path.match(/^\/api\/feedback\/(\d+)\/comments$/);

  // ?? GET /api/feedback/:id ???????????????????????????????????
  if (idMatch && method === 'GET') {
    const row = await db.prepare('SELECT * FROM feedback WHERE id=?').bind(idMatch[1]).first();
    if (!row) return json({ error: 'Not found' }, 404);
    return json({ success: true, item: row });
  }

  // ?? PUT /api/feedback/:id ???섏젙 (?묒꽦???먮뒗 admin/pd) ?????
  if (idMatch && method === 'PUT') {
    const row = await db.prepare('SELECT * FROM feedback WHERE id=?').bind(idMatch[1]).first();
    if (!row) return json({ error: 'Not found' }, 404);
    if (!isAdminOrPd && row.member_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const body = await request.json();
    const sets = [], vals = [];
    if (body.title    !== undefined) { sets.push('title=?');    vals.push(body.title); }
    if (body.body     !== undefined) { sets.push('body=?');     vals.push(body.body); }
    if (body.category !== undefined) { sets.push('category=?'); vals.push(body.category); }
    if (body.priority !== undefined) { sets.push('priority=?'); vals.push(body.priority); }
    if (body.page     !== undefined) { sets.push('page=?');     vals.push(body.page); }
    if (!sets.length) return json({ error: 'No fields to update' }, 400);
    sets.push("updated_at=datetime('now')");
    vals.push(idMatch[1]);
    await db.prepare(`UPDATE feedback SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
    return json({ success: true });
  }

  // ?? PUT /api/feedback/:id/status ???곹깭 蹂寃?(admin/pd ?꾩슜)
  if (statusMatch && method === 'PUT') {
    if (!isAdminOrPd) return json({ error: 'Forbidden' }, 403);
    const body = await request.json();
    if (!body.status) return json({ error: 'status is required' }, 400);
    const extra = body.status === 'resolved'
      ? ", resolution=?, resolved_at=datetime('now')"
      : '';
    const params = [body.status];
    if (extra) params.push(body.resolution || null);
    params.push(statusMatch[1]);
    await db.prepare(
      `UPDATE feedback SET status=?${extra}, updated_at=datetime('now') WHERE id=?`
    ).bind(...params).run();
    return json({ success: true });
  }

  // ?? DELETE /api/feedback/:id ????젣 (admin ?꾩슜) ????????????
  if (idMatch && method === 'DELETE') {
    if (user.role !== 'admin') return json({ error: 'Forbidden' }, 403);
    await db.prepare('DELETE FROM feedback_comments WHERE feedback_id=?').bind(idMatch[1]).run();
    await db.prepare('DELETE FROM feedback WHERE id=?').bind(idMatch[1]).run();
    return json({ success: true });
  }

  // ?? POST /api/feedback/:id/comments ??肄붾찘??異붽? ???????????
  if (commentMatch && method === 'POST') {
    const body = await request.json();
    if (!body.body) return json({ error: 'body is required' }, 400);
    // feedback 議댁옱 ?뺤씤
    const fb = await db.prepare('SELECT id FROM feedback WHERE id=?').bind(commentMatch[1]).first();
    if (!fb) return json({ error: 'Feedback not found' }, 404);
    const result = await db.prepare(
      `INSERT INTO feedback_comments (feedback_id, author_type, author_name, body)
       VALUES (?, ?, ?, ?)`
    ).bind(
      parseInt(commentMatch[1]),
      isAdminOrPd ? 'dev' : 'member',
      user.name || user.email || null,
      body.body
    ).run();
    // 肄붾찘??異붽? ??feedback updated_at 媛깆떊
    await db.prepare("UPDATE feedback SET updated_at=datetime('now') WHERE id=?").bind(commentMatch[1]).run();
    return json({ success: true, id: result.meta?.last_row_id });
  }

  // ?? GET /api/feedback/:id/comments ??肄붾찘??紐⑸줉 ????????????
  if (commentMatch && method === 'GET') {
    const rows = await db.prepare(
      'SELECT * FROM feedback_comments WHERE feedback_id=? ORDER BY created_at ASC'
    ).bind(commentMatch[1]).all();
    return json({ success: true, comments: rows.results });
  }

  return json({ error: 'Not found' }, 404);
}

// ===== ADMIN API ??/api/admin/* (admin ?꾩슜) =====
async function handleAdminAPI(path, req, env) {
  const user = await authenticateAny(req, env);
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);

  const db = env.DB;
  const method = req.method;
  const url = new URL(req.url);

  // ?? GET /api/admin/ai-costs ??AI 鍮꾩슜 ?붿빟 ??????????????????
  if (path === '/api/admin/ai-costs' && method === 'GET') {
    const days = parseInt(url.searchParams.get('days') || '30');
    const since = Date.now() - days * 86400000;

    // 紐⑤뜽蹂??좏겙 吏묎퀎
    const byModel = await db.prepare(`
      SELECT model,
        COUNT(*) as call_count,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output
      FROM api_usage
      WHERE created_at > ?
      GROUP BY model ORDER BY total_output DESC
    `).bind(since).all();

    // ?붾뱶?ъ씤?몃퀎 吏묎퀎
    const byEndpoint = await db.prepare(`
      SELECT endpoint,
        COUNT(*) as call_count,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output
      FROM api_usage
      WHERE created_at > ?
      GROUP BY endpoint ORDER BY call_count DESC
    `).bind(since).all();

    // ?쇰퀎 異붿씠
    const daily = await db.prepare(`
      SELECT date(created_at/1000, 'unixepoch') as day,
        COUNT(*) as calls,
        SUM(input_tokens) as input_tok,
        SUM(output_tokens) as output_tok
      FROM api_usage
      WHERE created_at > ?
      GROUP BY day ORDER BY day DESC LIMIT 30
    `).bind(since).all();

    // 鍮꾩슜 怨꾩궛 (USD, per 1M tokens)
    const pricing = {
      'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
      'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00 },
      'claude-opus-4-6': { input: 15.00, output: 75.00 }
    };

    let totalCostUsd = 0;
    const costByModel = (byModel.results || []).map(r => {
      const p = pricing[r.model] || { input: 3.0, output: 15.0 };
      const cost = ((r.total_input || 0) * p.input + (r.total_output || 0) * p.output) / 1000000;
      totalCostUsd += cost;
      return { ...r, cost_usd: Math.round(cost * 10000) / 10000 };
    });

    return json({
      success: true,
      period_days: days,
      total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
      by_model: costByModel,
      by_endpoint: byEndpoint.results || [],
      daily: daily.results || []
    });
  }

  // ?? GET /api/admin/ai-costs/users ???ъ슜?먮퀎 鍮꾩슜 ??????????
  if (path === '/api/admin/ai-costs/users' && method === 'GET') {
    const days = parseInt(url.searchParams.get('days') || '30');
    const since = Date.now() - days * 86400000;

    const byUser = await db.prepare(`
      SELECT u.user_id, m.name as user_name, m.role,
        COUNT(*) as call_count,
        SUM(u.input_tokens) as total_input,
        SUM(u.output_tokens) as total_output
      FROM api_usage u
      LEFT JOIN members m ON CAST(u.user_id AS TEXT) = CAST(m.id AS TEXT)
      WHERE u.created_at > ?
      GROUP BY u.user_id ORDER BY total_output DESC
    `).bind(since).all();

    return json({ success: true, by_user: byUser.results || [] });
  }

  return json({ error: 'Not found' }, 404);
}

// ===== APPROVALS API ??/api/approvals/* (?뱀씤?붿껌 ?쒖뒪?? =====
async function handleApprovalsAPI(path, req, env) {
  const user = await authenticateAny(req, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const db = env.DB;
  const method = req.method;
  const isAdminOrPd = user.role === 'admin' || user.role === 'pd';

  // ?뚯씠釉??먮룞 ?앹꽦 (泥??몄텧 ??
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL,
      requester_name TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      target_data TEXT,
      status TEXT DEFAULT 'pending',
      reviewer_id INTEGER,
      reviewer_name TEXT,
      review_comment TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // ?? POST /api/approvals ???뱀씤?붿껌 ?앹꽦 ????????????????????
  if (path === '/api/approvals' && method === 'POST') {
    const { type, title, description, target_data } = await req.json();
    if (!type || !title) return json({ error: 'type and title required' }, 400);

    const validTypes = ['shot_status', 'asset_request', 'schedule_change', 'render_request', 'overtime', 'access_request', 'other'];
    if (!validTypes.includes(type)) return json({ error: `Invalid type. Use: ${validTypes.join(', ')}` }, 400);

    const result = await db.prepare(`
      INSERT INTO approval_requests (requester_id, requester_name, type, title, description, target_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(user.id, user.name || user.email, type, title, description || null, target_data ? JSON.stringify(target_data) : null).run();

    // admin/pd?먭쾶 ?뚮┝ ?앹꽦
    const admins = await db.prepare("SELECT id FROM members WHERE role IN ('admin','pd')").all();
    for (const admin of (admins.results || [])) {
      await db.prepare(
        "INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'approval', ?, ?)"
      ).bind(admin.id, `Approval: ${title}`, `${user.name || 'user'} requested ${type} approval`).run();
    }

    return json({ success: true, id: result.meta?.last_row_id });
  }

  // ?? GET /api/approvals/stats ???듦퀎 (admin/pd) ?????????????
  if (path === '/api/approvals/stats' && method === 'GET') {
    if (!isAdminOrPd) return json({ error: 'Forbidden' }, 403);

    const stats = await db.prepare(`
      SELECT status, COUNT(*) as count FROM approval_requests GROUP BY status
    `).all();
    const byType = await db.prepare(`
      SELECT type, COUNT(*) as count FROM approval_requests WHERE status='pending' GROUP BY type
    `).all();

    return json({ success: true, by_status: stats.results || [], pending_by_type: byType.results || [] });
  }

  // ?? GET /api/approvals ???뱀씤?붿껌 紐⑸줉 ?????????????????????
  if (path === '/api/approvals' && method === 'GET') {
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const mine = url.searchParams.get('mine');

    let sql = 'SELECT * FROM approval_requests';
    const params = [];
    const conditions = [];

    if (status) { conditions.push('status = ?'); params.push(status); }
    if (mine === 'true') { conditions.push('requester_id = ?'); params.push(user.id); }
    else if (!isAdminOrPd) { conditions.push('requester_id = ?'); params.push(user.id); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT 100';

    const rows = await db.prepare(sql).bind(...params).all();
    return json({ success: true, approvals: rows.results || [] });
  }

  // ?? GET /api/approvals/:id ???곸꽭 ??????????????????????????
  const idMatch = path.match(/^\/api\/approvals\/(\d+)$/);
  if (idMatch && method === 'GET') {
    const row = await db.prepare('SELECT * FROM approval_requests WHERE id=?').bind(idMatch[1]).first();
    if (!row) return json({ error: 'Not found' }, 404);
    if (!isAdminOrPd && row.requester_id !== user.id) return json({ error: 'Forbidden' }, 403);
    return json({ success: true, approval: row });
  }

  // ?? PUT /api/approvals/:id ???뱀씤/諛섎젮 (admin/pd ?꾩슜) ?????
  if (idMatch && method === 'PUT') {
    if (!isAdminOrPd) return json({ error: 'Forbidden' }, 403);

    const { status, review_comment } = await req.json();
    if (!['approved', 'rejected'].includes(status)) return json({ error: 'status must be approved or rejected' }, 400);

    await db.prepare(`
      UPDATE approval_requests SET status=?, reviewer_id=?, reviewer_name=?, review_comment=?, reviewed_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).bind(status, user.id, user.name || user.email, review_comment || null, idMatch[1]).run();

    // ?붿껌?먯뿉寃??뚮┝
    const row = await db.prepare('SELECT requester_id, title FROM approval_requests WHERE id=?').bind(idMatch[1]).first();
    if (row) {
      const statusKr = status === 'approved' ? 'approved' : 'rejected';
      await db.prepare(
        "INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'approval_result', ?, ?)"
      ).bind(row.requester_id, `${statusKr}: ${row.title}`, review_comment || `${user.name || 'Admin'}??媛) ${statusKr} 泥섎━?덉뒿?덈떎`).run();
    }

    return json({ success: true, status });
  }

  // ?? DELETE /api/approvals/:id ????젣 (?묒꽦???먮뒗 admin) ???
  if (idMatch && method === 'DELETE') {
    const row = await db.prepare('SELECT requester_id FROM approval_requests WHERE id=?').bind(idMatch[1]).first();
    if (!row) return json({ error: 'Not found' }, 404);
    if (user.role !== 'admin' && row.requester_id !== user.id) return json({ error: 'Forbidden' }, 403);

    await db.prepare('DELETE FROM approval_requests WHERE id=?').bind(idMatch[1]).run();
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}

// ===================================================================
// NAS API ??Synology File Station via CF Tunnel
// Secrets: NAS_API_URL, NAS_ACCOUNT, NAS_PASSWORD
// ===================================================================

const NAS_ROOT = '/NEW_AIVE/TBO';
const NAS_HEAVY_EXT = new Set([
  '.mov','.mp4','.mxf','.r3d','.ari','.braw','.dpx','.exr',
  '.prproj','.aep','.c4d','.blend','.ma','.mb','.psb','.psd',
  '.tif','.tiff','.wav','.aiff','.hip','.nk'
]);

async function getNasConfig(env) {
  let url = env.NAS_API_URL || '';
  let account = env.NAS_ACCOUNT || '';
  let password = env.NAS_PASSWORD || '';
  // D1 app_config fallback for NAS settings
  if (env.DB) {
    try {
      const keys = ['NAS_API_URL', 'NAS_ACCOUNT', 'NAS_PASSWORD'];
      const rows = await env.DB.prepare(
        "SELECT key, value FROM app_config WHERE key IN ('NAS_API_URL','NAS_ACCOUNT','NAS_PASSWORD')"
      ).all();
      for (const r of (rows.results || [])) {
        if (r.key === 'NAS_API_URL' && r.value) url = r.value;
        if (r.key === 'NAS_ACCOUNT' && r.value) account = r.value;
        if (r.key === 'NAS_PASSWORD' && r.value) password = r.value;
      }
    } catch (e) { /* ignore D1 errors, fall back to env */ }
  }
  return { url, account, password };
}

async function nasCall(env, params = {}) {
  const nasCfg = await getNasConfig(env);
  const baseUrl = nasCfg.url;
  if (!baseUrl) throw new Error('NAS_API_URL not configured');
  let sid = env.NAS_SID || '';
  if (!sid && nasCfg.account && nasCfg.password) {
    const loginUrl = `${baseUrl}/webapi/auth.cgi?api=SYNO.API.Auth&version=6&method=login&account=${encodeURIComponent(nasCfg.account)}&passwd=${encodeURIComponent(nasCfg.password)}&session=FileStation&format=sid`;
    const lr = await fetch(loginUrl);
    const ld = await lr.json();
    if (ld.success) sid = ld.data.sid;
    else throw new Error('NAS login failed');
  }
  const qs = new URLSearchParams({ ...params, _sid: sid });
  const resp = await fetch(`${baseUrl}/webapi/entry.cgi?${qs}`);
  return resp.json();
}

async function nasStatus(env) {
  const nasCfg = await getNasConfig(env);
  if (!nasCfg.url) {
    return json({ connected: false, reason: 'NAS_API_URL not configured',
      setup: { step1: 'Worker Secret NAS_API_URL ?ㅼ젙', step2: 'Worker Secrets NAS_ACCOUNT, NAS_PASSWORD ?ㅼ젙', step3: '/api/nas/status濡??곌껐 ?뺤씤' }
    });
  }
  try {
    const data = await nasCall(env, { api: 'SYNO.FileStation.Info', version: '2', method: 'get' });
    return json({ connected: true, info: data.data || data });
  } catch (e) {
    return json({ connected: false, error: e.message });
  }
}

async function nasList(req, env) {
  const url = new URL(req.url);
  const relPath = url.searchParams.get('path') || '/';
  const limit = parseInt(url.searchParams.get('limit') || '200');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const folderPath = NAS_ROOT + (relPath.startsWith('/') ? relPath : '/' + relPath);
  try {
    const data = await nasCall(env, {
      api: 'SYNO.FileStation.List', version: '2', method: 'list',
      folder_path: folderPath, offset: String(offset), limit: String(limit),
      additional: '["size","time","type"]', sort_by: 'name'
    });
    if (!data.success) return json({ error: 'NAS API error', detail: data.error }, 502);
    const files = (data.data?.files || []).map(f => ({
      name: f.name, path: f.path.replace(NAS_ROOT, ''),
      isdir: f.isdir, size: f.additional?.size || 0,
      mtime: f.additional?.time?.mtime || 0
    }));
    return json({ path: relPath, total: data.data?.total || files.length, files });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

async function nasScan(req, env) {
  const body = await req.json().catch(() => ({}));
  const scanPath = body.path || '/02_Scenes';
  const projectId = body.project_id || 'prj_tbo_s1';
  const scanId = 'nscan_' + Date.now().toString(36);
  await env.DB.prepare(
    "INSERT INTO nas_scan_runs (id, started_at, status, root) VALUES (?, ?, 'running', ?)"
  ).bind(scanId, Date.now(), scanPath).run();
  try {
    const data = await nasCall(env, {
      api: 'SYNO.FileStation.List', version: '2', method: 'list',
      folder_path: NAS_ROOT + scanPath, limit: '5000',
      additional: '["size","time"]', sort_by: 'name'
    });
    if (!data.success) throw new Error('NAS list failed');
    const nasFiles = data.data?.files || [];
    const { results: shots } = await env.DB.prepare(
      "SELECT id, shot_code, status FROM shots WHERE project_id = ?"
    ).bind(projectId).all();
    const shotMap = new Map(shots.map(s => [s.shot_code, s]));
    let matched = 0, missing = 0, orphan = 0;
    const diffs = [];
    for (const f of nasFiles) {
      if (f.isdir) continue;
      const m = f.name.match(/TB_EP(\d{3})_s(\d{3})_c(\d{3})/i);
      if (m) {
        const code = `TB_EP${m[1]}_s${m[2]}_c${m[3]}`;
        if (shotMap.has(code)) { matched++; shotMap.delete(code); }
        else { orphan++; diffs.push({ type: 'orphan', name: f.name }); }
      }
    }
    for (const [code] of shotMap) { missing++; diffs.push({ type: 'missing', shot_code: code }); }
    await env.DB.prepare(
      "UPDATE nas_scan_runs SET finished_at=?, status='done', files_total=?, shots_matched=?, shots_missing=?, files_orphan=?, diff_json=?, total_size_bytes=? WHERE id=?"
    ).bind(Date.now(), nasFiles.length, matched, missing, orphan, JSON.stringify(diffs.slice(0, 500)),
      nasFiles.reduce((a, f) => a + (f.additional?.size || 0), 0), scanId).run();
    return json({ scan_id: scanId, status: 'done', files_total: nasFiles.length, shots_matched: matched, shots_missing: missing, files_orphan: orphan, diffs_sample: diffs.slice(0, 20) });
  } catch (e) {
    await env.DB.prepare("UPDATE nas_scan_runs SET finished_at=?, status='error', error_msg=? WHERE id=?").bind(Date.now(), e.message, scanId).run();
    return json({ scan_id: scanId, status: 'error', error: e.message }, 502);
  }
}

async function nasScanLatest(env) {
  const row = await env.DB.prepare("SELECT * FROM nas_scan_runs ORDER BY started_at DESC LIMIT 1").first();
  if (!row) return json({ error: 'No scans' }, 404);
  return json(row);
}

async function nasScanGet(scanId, env) {
  const row = await env.DB.prepare("SELECT * FROM nas_scan_runs WHERE id = ?").bind(scanId).first();
  if (!row) return json({ error: 'Not found' }, 404);
  if (row.diff_json) try { row.diffs = JSON.parse(row.diff_json); } catch {}
  return json(row);
}

async function nasIngestVersion(req, env) {
  const syncKey = req.headers.get('x-sync-key') || '';
  if (syncKey !== 'sjsync_2026_TBO_autoUpload') return json({ error: 'Invalid sync key' }, 401);
  const body = await req.json().catch(() => ({}));
  const { task_id, shot_id, source_path, file_name, version_num, is_final, size, mime_type, note } = body;
  if (!file_name) return json({ error: 'file_name required' }, 400);
  const vId = 'ver_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    await env.DB.prepare(
      "INSERT INTO versions (id, task_id, uploader_id, note, status, nas_source_path, shot_id, version_num, is_final, source, file_name, mime_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(vId, task_id || '', 'nas_agent', note || null, 'pending', source_path || null, shot_id || null, version_num || 1, is_final ? 1 : 0, 'nas_auto', file_name, mime_type || null).run();
    return json({ version_id: vId, status: 'pending', source: 'nas_auto' });
  } catch (e) {
    return json({ error: 'DB insert failed', detail: e.message }, 500);
  }
}

async function folderLinksList(req, env) {
  const pid = new URL(req.url).searchParams.get('project_id') || 'default';
  const { results } = await env.DB.prepare(
    "SELECT * FROM folder_links WHERE project_id = ? AND archived = 0 ORDER BY created_at DESC"
  ).bind(pid).all();
  return json({ data: results, total: results.length });
}

async function folderLinksGet(id, env) {
  const row = await env.DB.prepare("SELECT * FROM folder_links WHERE id = ?").bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json(row);
}

async function folderLinksCreate(req, env) {
  const body = await req.json().catch(() => ({}));
  const id = 'fl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await env.DB.prepare(
    "INSERT INTO folder_links (id, project_id, label, kind, nas_url, nas_caption, nas_note, created_at, upload_roles, download_roles) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, body.project_id || 'default', body.label || 'Untitled', body.kind || 'reference', body.nas_url || null, body.nas_caption || null, body.nas_note || null, Date.now(), JSON.stringify(body.upload_roles || []), JSON.stringify(body.download_roles || [])).run();
  return json({ id, created: true });
}

async function folderLinksUpdate(id, req, env) {
  const body = await req.json().catch(() => ({}));
  const sets = [], vals = [];
  for (const k of ['label','kind','nas_url','nas_caption','nas_note','verified_at','verify_status']) {
    if (body[k] !== undefined) { sets.push(k + ' = ?'); vals.push(body[k]); }
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);
  vals.push(id);
  await env.DB.prepare('UPDATE folder_links SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
  return json({ id, updated: true });
}

async function folderLinksDelete(id, env) {
  await env.DB.prepare("UPDATE folder_links SET archived = 1, archived_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return json({ id, archived: true });
}

function storageMode(req) {
  const ext = (new URL(req.url).searchParams.get('ext') || '').toLowerCase();
  const normalized = ext.startsWith('.') ? ext : '.' + ext;
  return json({ mode: NAS_HEAVY_EXT.has(normalized) ? 'nas' : 'r2', ext: normalized });
}

// ===== Workflow API Handler =====
// Morphic-style workflow engine for STUDIOJUN
// Routes: /api/workflows/*

async function handleWorkflowAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  // GET /api/workflows/list
  if (path === '/api/workflows/list' && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT id, name, description, preset_type, thumbnail_url, use_count, is_active,
       json_array_length(steps_json) as step_count, created_at, updated_at
       FROM workflows WHERE is_active = 1 ORDER BY use_count DESC`
    ).all();
    return json({ workflows: results, total: results.length });
  }

  // GET /api/workflows/:id
  const detailMatch = path.match(/^\/api\/workflows\/([a-f0-9]+)$/);
  if (detailMatch && method === 'GET') {
    const wf = await db.prepare(`SELECT * FROM workflows WHERE id = ?`).bind(detailMatch[1]).first();
    if (!wf) return json({ error: 'Workflow not found' }, 404);
    wf.steps = JSON.parse(wf.steps_json || '[]');
    wf.default_params = JSON.parse(wf.default_params_json || '{}');
    return json({ workflow: wf });
  }

  // POST /api/workflows/create
  if (path === '/api/workflows/create' && method === 'POST') {
    const body = await request.json();
    const { name, description, preset_type, steps, default_params, thumbnail_url } = body;
    if (!name || !steps) return json({ error: 'name and steps required' }, 400);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await db.prepare(
      `INSERT INTO workflows (id, name, description, preset_type, steps_json, default_params_json, thumbnail_url, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, description || '', preset_type || 'custom',
      JSON.stringify(steps), JSON.stringify(default_params || {}),
      thumbnail_url || null, 'api'
    ).run();
    return json({ success: true, id });
  }

  // POST /api/workflows/run
  if (path === '/api/workflows/run' && method === 'POST') {
    const body = await request.json();
    const { workflow_id, episode_id, shot_id, inputs } = body;
    if (!workflow_id) return json({ error: 'workflow_id required' }, 400);
    const wf = await db.prepare(`SELECT * FROM workflows WHERE id = ?`).bind(workflow_id).first();
    if (!wf) return json({ error: 'Workflow not found' }, 404);
    const steps = JSON.parse(wf.steps_json || '[]');
    const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, episode_id, shot_id, inputs_json, status, current_step, total_steps, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, ?)`
    ).bind(runId, workflow_id, episode_id || null, shot_id || null,
      JSON.stringify(inputs || {}), steps.length, now, now
    ).run();
    await db.prepare(`UPDATE workflows SET use_count = use_count + 1, updated_at = unixepoch() WHERE id = ?`)
      .bind(workflow_id).run();
    return json({ success: true, run_id: runId, workflow: wf.name, total_steps: steps.length });
  }

  // GET /api/workflows/runs
  if (path === '/api/workflows/runs' && method === 'GET') {
    const url = new URL(request.url);
    const wfId = url.searchParams.get('workflow_id');
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    let sql = `SELECT wr.*, w.name as workflow_name FROM workflow_runs wr
               LEFT JOIN workflows w ON wr.workflow_id = w.id WHERE 1=1`;
    const params = [];
    if (wfId) { sql += ` AND wr.workflow_id = ?`; params.push(wfId); }
    if (status) { sql += ` AND wr.status = ?`; params.push(status); }
    sql += ` ORDER BY wr.created_at DESC LIMIT ?`;
    params.push(limit);
    const stmt = db.prepare(sql);
    const { results } = await (params.length === 1 ? stmt.bind(params[0]) :
      params.length === 2 ? stmt.bind(params[0], params[1]) :
      stmt.bind(params[0], params[1], params[2])).all();
    return json({ runs: results, total: results.length });
  }

  // GET /api/workflows/run/:id
  const runStatusMatch = path.match(/^\/api\/workflows\/run\/([a-f0-9]+)$/);
  if (runStatusMatch && method === 'GET') {
    const run = await db.prepare(
      `SELECT wr.*, w.name as workflow_name, w.steps_json
       FROM workflow_runs wr LEFT JOIN workflows w ON wr.workflow_id = w.id WHERE wr.id = ?`
    ).bind(runStatusMatch[1]).first();
    if (!run) return json({ error: 'Run not found' }, 404);
    run.inputs = JSON.parse(run.inputs_json || '{}');
    run.outputs = JSON.parse(run.outputs_json || '{}');
    run.steps = JSON.parse(run.steps_json || '[]');
    return json({ run });
  }

  // POST /api/workflows/run/:id/step
  const stepMatch = path.match(/^\/api\/workflows\/run\/([a-f0-9]+)\/step$/);
  if (stepMatch && method === 'POST') {
    const runId = stepMatch[1];
    const body = await request.json();
    const { step_output, status } = body;
    const run = await db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).bind(runId).first();
    if (!run) return json({ error: 'Run not found' }, 404);
    const outputs = JSON.parse(run.outputs_json || '{}');
    outputs[`step_${run.current_step}`] = step_output || {};
    const nextStep = run.current_step + 1;
    const isDone = nextStep >= run.total_steps || status === 'done';
    const isError = status === 'error';
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `UPDATE workflow_runs SET current_step = ?, outputs_json = ?, status = ?, completed_at = ? WHERE id = ?`
    ).bind(nextStep, JSON.stringify(outputs),
      isError ? 'error' : (isDone ? 'done' : 'running'),
      (isDone || isError) ? now : null, runId
    ).run();
    return json({ success: true, current_step: nextStep, status: isDone ? 'done' : (isError ? 'error' : 'running') });
  }

  // POST /api/workflows/prompt-log
  if (path === '/api/workflows/prompt-log' && method === 'POST') {
    const body = await request.json();
    const { job_id, workflow_run_id, prompt, model, mode, ref_assets, result_url, r2_key,
            rating, is_success, failure_reason, notes } = body;
    if (!prompt) return json({ error: 'prompt required' }, 400);
    const wordCount = prompt.trim().split(/\s+/).length;
    await db.prepare(
      `INSERT INTO prompt_log (job_id, workflow_run_id, prompt, model, mode, ref_assets_json,
       result_url, r2_key, rating, is_success, failure_reason, notes, word_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(job_id || null, workflow_run_id || null, prompt,
      model || 'seedance-2.0', mode || 'i2v',
      JSON.stringify(ref_assets || []), result_url || null, r2_key || null,
      rating || null, is_success !== undefined ? (is_success ? 1 : 0) : 1,
      failure_reason || null, notes || null, wordCount
    ).run();
    return json({ success: true, word_count: wordCount });
  }

  // GET /api/workflows/prompt-log
  if (path === '/api/workflows/prompt-log' && method === 'GET') {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const successOnly = url.searchParams.get('success') === '1';
    let sql = `SELECT * FROM prompt_log WHERE 1=1`;
    if (successOnly) sql += ` AND is_success = 1`;
    sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
    const { results } = await db.prepare(sql).all();
    return json({ logs: results, total: results.length });
  }

  // GET /api/workflows/prompt-log/stats
  if (path === '/api/workflows/prompt-log/stats' && method === 'GET') {
    const stats = await db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) as fail_count,
        ROUND(AVG(word_count), 1) as avg_word_count,
        ROUND(AVG(CASE WHEN rating IS NOT NULL THEN rating END), 2) as avg_rating,
        MIN(word_count) as min_words, MAX(word_count) as max_words
      FROM prompt_log
    `).first();
    return json({ stats });
  }

  return json({ error: 'Unknown workflow endpoint', path }, 404);
}

// ===== HeyGen Video Translate API Proxy =====
async function handleHeyGenAPI(path, request, env) {
  const method = request.method;
  const db = env.DB;

  async function getHeyGenKey() {
    try {
      const row = await db.prepare('SELECT value FROM app_config WHERE key = ?').bind('HEYGEN_API_KEY').first();
      return row?.value || null;
    } catch { return null; }
  }

  // 지원 언어 목록
  if (path === '/api/heygen/languages' && method === 'GET') {
    const apiKey = await getHeyGenKey();
    if (!apiKey) return json({ error: 'HEYGEN_API_KEY not configured' }, 400);
    const resp = await fetch('https://api.heygen.com/v2/video_translate/target_languages', {
      headers: { 'X-Api-Key': apiKey }
    });
    const data = await resp.json();
    return json(data, resp.status);
  }

  // 번역 작업 생성 (R2 영상 기반)
  if ((path === '/api/heygen/translate' || path === '/api/heygen/translate-r2') && method === 'POST') {
    const apiKey = await getHeyGenKey();
    if (!apiKey) return json({ error: 'HEYGEN_API_KEY not configured' }, 400);

    const contentType = request.headers.get('content-type') || '';
    let videoUrl = null;
    let outputLanguage = 'en';
    let title = '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('video');
      outputLanguage = formData.get('output_language') || 'en';
      title = formData.get('title') || 'Guide Translation';

      if (file && file instanceof File) {
        const r2Key = `heygen/originals/${Date.now()}_${file.name}`;
        await env.ASSETS.put(r2Key, file.stream(), {
          httpMetadata: { contentType: file.type }
        });
        const heygenForm = new FormData();
        heygenForm.append('video_input', file);
        heygenForm.append('output_language', outputLanguage);
        heygenForm.append('title', title);

        const resp = await fetch('https://api.heygen.com/v2/video_translate', {
          method: 'POST',
          headers: { 'X-Api-Key': apiKey },
          body: heygenForm
        });
        const data = await resp.json();
        if (data.data?.video_translate_id) {
          await db.prepare(`INSERT OR REPLACE INTO heygen_jobs (id, title, output_language, r2_original_key, status, created_at) VALUES (?, ?, ?, ?, 'pending', unixepoch())`).bind(data.data.video_translate_id, title, outputLanguage, r2Key).run().catch(()=>{});
        }
        return json(data, resp.status);
      }
    } else {
      const body = await request.json();
      // translate-r2: r2_key -> public URL
      if (path === '/api/heygen/translate-r2' && body.r2_key) {
        const baseUrl = new URL(request.url).origin;
        videoUrl = `${baseUrl}/r2/public/${body.r2_key}?token=sj_guide_2026`;
      } else {
        videoUrl = body.video_url;
      }
      outputLanguage = body.output_language || 'en';
      title = body.title || 'Guide Translation';

      if (!videoUrl) return json({ error: 'video_url or r2_key required' }, 400);

      const resp = await fetch('https://api.heygen.com/v2/video_translate', {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: videoUrl, output_language: outputLanguage, title: title })
      });
      const data = await resp.json();
      if (data.data?.video_translate_id) {
        await db.prepare(`INSERT OR REPLACE INTO heygen_jobs (id, title, output_language, video_url, status, created_at) VALUES (?, ?, ?, ?, 'pending', unixepoch())`).bind(data.data.video_translate_id, title, outputLanguage, videoUrl).run().catch(()=>{});
      }
      return json(data, resp.status);
    }
  }

  // 번역 상태 확인
  const statusMatch = path.match(/^\/api\/heygen\/status\/([^/]+)$/);
  if (statusMatch && method === 'GET') {
    const apiKey = await getHeyGenKey();
    if (!apiKey) return json({ error: 'HEYGEN_API_KEY not configured' }, 400);
    const translateId = statusMatch[1];
    const resp = await fetch(`https://api.heygen.com/v2/video_translate/${translateId}`, {
      headers: { 'X-Api-Key': apiKey }
    });
    const data = await resp.json();
    if (data.data?.status === 'completed' && data.data?.url) {
      try {
        const videoResp = await fetch(data.data.url);
        if (videoResp.ok) {
          const r2Key = `heygen/translated/${translateId}.mp4`;
          await env.ASSETS.put(r2Key, videoResp.body, { httpMetadata: { contentType: 'video/mp4' } });
          await db.prepare(`UPDATE heygen_jobs SET status='completed', r2_translated_key=?, heygen_url=?, completed_at=unixepoch() WHERE id=?`).bind(r2Key, data.data.url, translateId).run();
          data.data.r2_key = r2Key;
        }
      } catch (e) { console.error('R2 save failed:', e); }
    } else if (data.data?.status === 'failed') {
      await db.prepare(`UPDATE heygen_jobs SET status='failed' WHERE id=?`).bind(translateId).run().catch(()=>{});
    }
    return json(data, resp.status);
  }

  // 작업 목록
  if (path === '/api/heygen/jobs' && method === 'GET') {
    try {
      const jobs = await db.prepare('SELECT * FROM heygen_jobs ORDER BY created_at DESC LIMIT 50').all();
      return json({ success: true, jobs: jobs.results });
    } catch { return json({ success: true, jobs: [] }); }
  }

  // R2 번역 영상 서빙
  const videoMatch = path.match(/^\/api\/heygen\/video\/([^/]+)$/);
  if (videoMatch && method === 'GET') {
    const translateId = videoMatch[1];
    const r2Key = `heygen/translated/${translateId}.mp4`;
    const obj = await env.ASSETS.get(r2Key);
    if (!obj) return json({ error: 'Video not found' }, 404);
    return new Response(obj.body, {
      headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=86400' }
    });
  }

  return json({ error: 'Not found' }, 404);
}

