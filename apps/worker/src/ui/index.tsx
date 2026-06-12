import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { FC } from "hono/jsx";
import type { Env } from "../env";

const TOKEN_COOKIE = "brainfog_token";

export const uiRoutes = new Hono<{ Bindings: Env }>();

async function findUserByToken(env: Env, token: string) {
  const tokenHash = await hashToken(token, env.BRAINFOG_TOKEN_HASH_SECRET);
  const db = createDb(env.DB);
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(eq(tokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0];
}

const Layout: FC = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>brainfog</title>
      <style>{`
        body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
        input { width: 100%; padding: 0.5rem; margin: 0.5rem 0; box-sizing: border-box; }
        button { padding: 0.5rem 1rem; }
        .error { color: #b00020; }
      `}</style>
    </head>
    <body>
      <h1>brainfog</h1>
      {props.children}
    </body>
  </html>
);

const TokenForm: FC<{ error?: string }> = ({ error }) => (
  <form method="post" action="/">
    {error ? <p class="error">{error}</p> : null}
    <label for="token">Bearer token</label>
    <input type="password" id="token" name="token" required />
    <button type="submit">Sign in</button>
  </form>
);

uiRoutes.get("/", async (c) => {
  const token = getCookie(c, TOKEN_COOKIE);
  if (token) {
    const user = await findUserByToken(c.env, token);
    if (user) {
      return c.html(
        <Layout>
          <p>
            Signed in as <strong>{user.name}</strong>.
          </p>
        </Layout>,
      );
    }
  }
  return c.html(
    <Layout>
      <TokenForm />
    </Layout>,
  );
});

uiRoutes.post("/", async (c) => {
  const body = await c.req.parseBody();
  const token = typeof body.token === "string" ? body.token : "";
  const user = await findUserByToken(c.env, token);
  if (!user) {
    return c.html(
      <Layout>
        <TokenForm error="Invalid token." />
      </Layout>,
      401,
    );
  }

  setCookie(c, TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });

  return c.html(
    <Layout>
      <p>
        Signed in as <strong>{user.name}</strong>.
      </p>
    </Layout>,
  );
});
