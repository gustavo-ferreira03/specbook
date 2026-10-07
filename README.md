# Specbook

Self-hosted agent that turns a conversation into readable Specs (`spec.yml`) and executable Playwright tests (`spec.ts`), runs them when your app changes and investigates failures in a real browser.

## Run

```sh
docker compose up -d
```

Open [localhost:4001](http://localhost:4001). The setup wizard creates the admin account and connects a model. Data lives in the `specbook-storage` volume.

## Develop

Requires Linux, Node.js 26, pnpm, Xvfb and x11vnc.

```sh
pnpm install
pnpm --filter backend browser:install
pnpm dev
```

`pnpm typecheck` and `pnpm test` check the code.

## License

MIT
