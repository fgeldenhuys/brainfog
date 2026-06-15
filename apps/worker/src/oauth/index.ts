import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { lookupAuthenticatedUser } from "../auth-lookup";
import type { Env } from "../env";
import type { AuthVariables } from "../middleware/auth";

/**
 * Render GET /authorize form for OAuth token exchange.
 *
 * The form will be submitted with the oauth request info embedded as hidden fields,
 * parsed from the URL query parameters by OAuthProvider.parseAuthRequest().
 */
export async function handleAuthorizeGet(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): Promise<Response> {
  try {
    // Parse the authorization request from query parameters
    const oauthReqInfo = await c.env.OAUTH_PROVIDER?.parseAuthRequest(c.req.raw);
    if (!oauthReqInfo) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "Failed to parse authorization request",
        },
        400,
      );
    }

    // Verify client is registered
    const clientInfo = await c.env.OAUTH_PROVIDER?.lookupClient(oauthReqInfo.clientId);
    if (!clientInfo) {
      // Client not registered; return 400
      return c.json(
        {
          error: "invalid_client",
          error_description: "Client not registered",
        },
        400,
      );
    }

    // Serialize the OAuth request info to embed in the form
    const oauthReqInfoSerialized = Buffer.from(JSON.stringify(oauthReqInfo)).toString("base64");

    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <title>Brainfog OAuth Authorization</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 600px;
      margin: 100px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .form {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      margin-top: 0;
      color: #333;
    }
    p {
      color: #666;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 12px;
      margin: 10px 0;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-sizing: border-box;
      font-family: monospace;
      font-size: 13px;
    }
    input[type="hidden"] {
      display: none;
    }
    button {
      width: 100%;
      padding: 12px;
      margin-top: 15px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
    }
    button:hover {
      background: #0056b3;
    }
    .code-block {
      background: #f5f5f5;
      padding: 12px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
      color: #333;
      word-break: break-all;
      margin: 20px 0;
      display: none;
    }
    .code-block.active {
      display: block;
    }
    .error {
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      border-radius: 4px;
      padding: 12px;
      margin: 20px 0;
      color: #721c24;
      display: none;
    }
    .error.active {
      display: block;
    }
  </style>
</head>
<body>
  <div class="form">
    <h1>Brainfog OAuth Authorization</h1>
    <p>Paste your brainfog bearer token below to authorize this application.</p>
    <form onsubmit="submitForm(event)">
      <label for="token">Bearer Token:</label>
      <input
        type="password"
        id="token"
        name="token"
        placeholder="brainfog-token-..."
        required
        autocomplete="off"
      />
      <input type="hidden" id="oauthReqInfo" name="oauthReqInfo" value="${oauthReqInfoSerialized}" />
      <button type="submit">Authorize</button>
    </form>
    <div id="error-block" class="error"></div>
    <div id="code-block" class="code-block">
      <strong>Authorization Code:</strong>
      <div id="code-value" style="margin-top: 8px; word-break: break-all;"></div>
      <button type="button" onclick="copyCode()" style="margin-top: 12px; background: #28a745;">Copy Code</button>
      <a
        id="callback-link"
        href="#"
        style="display: block; box-sizing: border-box; width: 100%; padding: 12px; margin-top: 12px; background: #007bff; color: white; text-align: center; border-radius: 4px; text-decoration: none; font-weight: 600;"
      >Continue</a>
    </div>
    <p style="color: #999; font-size: 12px; margin-top: 30px;">
      Your token is sent over HTTPS and never stored on this server.
    </p>
  </div>

  <script>
    async function submitForm(event) {
      event.preventDefault();
      const token = document.getElementById('token').value;
      const oauthReqInfo = document.getElementById('oauthReqInfo').value;
      const errorBlock = document.getElementById('error-block');
      const codeBlock = document.getElementById('code-block');

      if (!token) {
        errorBlock.textContent = 'Please enter a token';
        errorBlock.classList.add('active');
        return;
      }

      try {
        const response = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, oauthReqInfo })
        });

        const data = await response.json();
        if (response.ok) {
          document.getElementById('code-value').textContent = data.authorization_code;
          document.getElementById('callback-link').href = data.redirect_uri;
          codeBlock.classList.add('active');
          errorBlock.classList.remove('active');
          document.getElementById('token').value = '';
        } else {
          errorBlock.textContent = 'Authorization failed: ' + (data.error_description || data.error || 'Unknown error');
          errorBlock.classList.add('active');
          codeBlock.classList.remove('active');
        }
      } catch (error) {
        errorBlock.textContent = 'Error: ' + (error instanceof Error ? error.message : 'Unknown error');
        errorBlock.classList.add('active');
        codeBlock.classList.remove('active');
      }
    }

    function copyCode() {
      const code = document.getElementById('code-value').textContent;
      navigator.clipboard.writeText(code).then(() => {
        alert('Authorization code copied!');
      }).catch(() => {
        alert('Failed to copy code');
      });
    }

    // Submit form on Enter key
    document.getElementById('token').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const form = e.target.closest('form');
        if (form) {
          const event = new Event('submit');
          form.dispatchEvent(event);
        }
      }
    });
  </script>
</body>
</html>`,
      {
        headers: { "Content-Type": "text/html" },
      },
    );
  } catch (err) {
    console.error("GET /authorize error:", err);
    return c.json(
      {
        error: "invalid_request",
        error_description: "Failed to parse authorization request",
      },
      400,
    );
  }
}

/**
 * Handle POST /authorize endpoint for OAuth authorization.
 *
 * Accepts a brainfog bearer token in the request body (POST),
 * validates it, and exchanges it for an OAuth authorization code.
 *
 * Per spec: credentials must be in the body (application/x-www-form-urlencoded
 * or application/json), never in the URL query parameter.
 *
 * Deviation: rather than redirecting the browser to the client's
 * redirect_uri (the typical authorization-code flow), this returns the
 * authorization_code as JSON. The client-side form on GET /authorize
 * displays it for copy/paste, since there is no registered client
 * application to redirect back to in brainfog's self-hosted setup.
 */
export async function handleAuthorizePost(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): Promise<Response> {
  const oauthProvider = c.env.OAUTH_PROVIDER;
  if (!oauthProvider) {
    return c.json({ error: "server_error", error_description: "OAuth provider unavailable" }, 500);
  }

  let token: string | undefined;
  let oauthReqInfoSerialized: string | undefined;

  // Parse token and oauth info from body
  const contentType = c.req.header("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await c.req.json()) as Record<string, unknown>;
      token = body.token as string | undefined;
      oauthReqInfoSerialized = body.oauthReqInfo as string | undefined;
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await c.req.text();
      const params = new URLSearchParams(text);
      token = params.get("token") || undefined;
      oauthReqInfoSerialized = params.get("oauthReqInfo") || undefined;
    } else {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "Content-Type must be application/json or application/x-www-form-urlencoded",
        },
        400,
      );
    }
  } catch {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Failed to parse request body",
      },
      400,
    );
  }

  if (!token) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "token field is required",
      },
      400,
    );
  }

  if (!oauthReqInfoSerialized) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "oauthReqInfo field is required",
      },
      400,
    );
  }

  // Deserialize OAuth request info
  let oauthReqInfo: AuthRequest;
  try {
    const decoded = Buffer.from(oauthReqInfoSerialized, "base64").toString("utf-8");
    oauthReqInfo = JSON.parse(decoded);
  } catch {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Invalid oauthReqInfo encoding",
      },
      400,
    );
  }

  // Validate the bearer token against D1
  const user = await lookupAuthenticatedUser(token, c.env);
  if (!user) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "Invalid bearer token",
      },
      401,
    );
  }

  try {
    // Call OAuthProvider to complete the authorization
    const { redirectTo } = await oauthProvider.completeAuthorization({
      request: oauthReqInfo,
      userId: user.id,
      metadata: { label: user.name },
      scope: oauthReqInfo.scope ?? [],
      props: {
        user: {
          id: user.id,
          name: user.name,
          selfPersonId: user.selfPersonId,
          slug: user.slug,
          isAdmin: user.isAdmin,
        },
      },
    });

    // Extract authorization code from the redirect URL
    const redirectUrl = new URL(redirectTo);
    const code = redirectUrl.searchParams.get("code");

    return c.json(
      {
        authorization_code: code,
        redirect_uri: redirectTo,
        user_id: user.id,
        user_name: user.name,
      },
      200,
    );
  } catch (err) {
    console.error("Authorization error:", err);
    return c.json(
      {
        error: "server_error",
        error_description: "Internal server error",
      },
      500,
    );
  }
}
