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

No plano gratuito o serviço dorme após ~15 min sem uso (o primeiro acesso leva ~1 min) e o disco é apagado a cada reinício/deploy.

### Ranking que não se perde (grátis, com Upstash Redis)
1. Crie uma conta em https://upstash.com → **Create Database** (Redis, região mais próxima, plano Free).
2. Na página do banco, em **REST API**, copie `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
3. No Render: serviço → **Environment** → **Add Environment Variable** → cole as duas (mesmos nomes) → **Save Changes** (o serviço reinicia).
4. No log do Render deve aparecer `ranking: Upstash (…)`.

Sem essas variáveis o ranking fica em `data/ranking.json` (ou em `DATA_DIR`, se houver disco persistente).
API: `/api/ranking` (recorde de cada pista) e `/api/ranking/<pista>?mode=solo|mp&items=with|without` (top 10). Melhor volta é o padrão; para o tempo total da corrida use também `kind=race&laps=1|3|5`.
