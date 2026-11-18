# Kart Rush v1.0 — servidor

Jogo de kart no navegador (24 pistas da F1 + Kart Point), com multijogador em salas, corrida com itens e ranking online por pista.

- `server.js` — servidor Node (HTTP + WebSocket em `/ws`)
- `public/` — o jogo (`index.html`) e os arquivos de modelos (`assets/`), texturas (`textures/`) e sons (`audio/`)

## Rodar no computador
```
npm install
npm start
```
Abra http://localhost:8080

## Publicar no Render
1. Envie esta pasta para um repositório no GitHub.
2. No Render: **New → Web Service** → escolha o repositório.
3. Runtime **Node**, Build `npm install`, Start `npm start`, plano **Free**. (Ou **New → Blueprint**, que lê o `render.yaml`.)
4. Compartilhe o endereço `https://….onrender.com`.

No plano gratuito o serviço dorme após ~15 min sem uso (o primeiro acesso leva ~1 min) e o ranking (`data/ranking.json`) é apagado a cada novo deploy/reinício. Para manter o ranking, use um plano com disco e defina `DATA_DIR` (veja o `render.yaml`).
