# CRM multi-escritorio — backend y despliegue

Prototipo de CRM para captar y digitalizar negocios sin presencia online.
Este repositorio contiene el frontend estático (`index.html`) **y** el API
(Node + TypeScript + Express + PostgreSQL) que lo alimenta.

## Versión

**Versión actual: 1.2.0** (27/10/2026)

- Se muestra en la app (sidebar, login y Configuración) y en `VERSION`.
- Antes de generar cada ZIP, sube la versión en **los cuatro sitios**:
  `index.html` (`APP_VERSION` y `APP_RELEASE`), `VERSION`, este README y
  `server/package.json`.
- Nombra el ZIP con la versión, por ejemplo: `crm-captacion-v1.2.0.zip`.

### Historial

- **1.2.0** — API de leads multiusuario y segura:
  - **Login y roles** (admin, supervisor, comercial, soporte). Toda la API
    salvo `/health`, `/api/auth/login` y `/api/ai/status` exige sesión. El
    primer admin se crea con `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
  - **El servidor ya no se cae** con datos erróneos: los errores de las rutas
    `async` responden 400/409/500 en vez de tumbar el proceso.
  - **Sin pérdidas entre comerciales:** ids generados en el servidor (UUID);
    el id del navegador se guarda en `client_ref`. Antes, dos navegadores con
    el mismo `L1001` se sobrescribían.
  - **Reimportar respeta la gestión:** si el negocio ya existe (mismo
    `place_id` o mismo teléfono) solo se refrescan los datos de Maps; estado,
    asignación, intentos y **«no contactar»** se conservan. El navegador
    adopta ese estado al sincronizar.
  - `PATCH` y `DELETE /api/leads/:id`, historial de interacciones, búsqueda
    por texto y teléfono, control de versiones (409 si otro usuario editó).
  - `/api/search` solo ejecuta el actor configurado en el servidor; se
    ignoran el `actor` y el `input` que envíe el navegador.
  - Fechas solo en ISO 8601, coordenadas `0,0` → vacías, `web_tipo`
    normalizado, límites de IA por usuario (no falseables por cabecera).
  - Pruebas de integración (`npm test`) contra PostgreSQL real.
- **1.1.0** — Estudio web en 3 pasos (fuentes, prompt IA y demo), prompt
  enriquecido con datos verificables y análisis de enlaces públicos, imágenes
  por sector, copia de seguridad/restauración de datos locales, deshacer y
  eliminar búsquedas, borrado seguro de leads y endpoints `/api/ai` +
  `/api/enrich` (clave de IA solo en el servidor).
- **1.0.2** — Corrige el error de búsqueda en Apify: `countryCode` se enviaba
  como `ES` y el actor solo acepta el código ISO en minúsculas (`es`). Afectaba
  a cualquier búsqueda (por ejemplo «Brunch»). También se normaliza en el
  backend para tolerar clientes antiguos.
- **1.0.1** — Paquete corregido para GitHub: incluye la búsqueda por palabras
  clave, la selección masiva de leads y el historial de búsquedas corregido.
  El ZIP anterior subido a GitHub era la build antigua sin estos cambios.
- **1.0.0** — Versión inicial numerada: búsqueda por palabras clave, selección
  masiva de leads (asignar, estado, no contactar, exportar y eliminar),
  historial de búsquedas corregido e integración con Google Maps vía Apify.

```
.
├─ index.html            # SPA (frontend). Configura la URL del API en Administración → Configuración.
├─ assets/               # imágenes del frontend
├─ server/               # API Node + TypeScript
│  ├─ src/
│  │  ├─ index.ts        # arranque Express + estáticos
│  │  ├─ env.ts          # variables de entorno
│  │  ├─ db.ts           # pool PostgreSQL + migración
│  │  ├─ schema.sql      # tablas leads / searches / settings
│  │  ├─ apify.ts        # proxy al actor de Apify (token en servidor)
│  │  ├─ ai.ts           # IA OpenAI-compatible + análisis de enlaces
│  │  ├─ auth.ts         # contraseñas (scrypt), sesiones firmadas y roles
│  │  ├─ http.ts         # wrapper async, errores HTTP y rate limit
│  │  ├─ validate.ts     # normalización y validación de leads
│  │  └─ routes/         # auth, search, leads, config, ai
│  ├─ test/              # pruebas de integración (npm test)
│  ├─ Dockerfile
│  ├─ .env.example
│  └─ Procfile
├─ docker-compose.yml    # API + PostgreSQL para desarrollo local
└─ railway.json          # despliegue en Railway (builder Dockerfile)
```

## API

Todas las rutas `/api/*` exigen `Authorization: Bearer <token>` salvo las
marcadas como públicas.

| Método | Ruta                            | Quién            | Descripción |
| ------ | ------------------------------- | ---------------- | ----------- |
| GET    | `/health`                       | público          | Estado del servicio, BD, Apify e IA. |
| POST   | `/api/auth/login`               | público          | `{ email, password }` → `{ token, expires_at, user }`. 10 intentos / 10 min por IP. |
| GET    | `/api/auth/me`                  | sesión           | Usuario de la sesión. |
| GET    | `/api/users`                    | admin, supervisor| Lista de usuarios. |
| POST   | `/api/users`                    | admin            | `{ id?, email, nombre?, rol, password }`. Usa los mismos ids que el frontend (u1, u2…). |
| PATCH  | `/api/users/:id`                | admin            | `{ nombre?, rol?, activo?, password? }`. Desactivar corta la sesión al momento. |
| POST   | `/api/search`                   | sesión           | `{ params: { sector, zona, max }, sinWeb?, persist? }`. Actor e input los decide el servidor. |
| POST   | `/api/leads`                    | sesión           | Importa leads (array o `{ leads }`, máx. 500). Ver «Deduplicación». |
| GET    | `/api/leads`                    | sesión           | `?estado=&asignado_a=(id\|none)&q=&ciudad=&sector=&no_contactar=&updated_since=&limit=&offset=` → `{ leads, total }`. |
| GET    | `/api/leads/:id`                | sesión           | Lead completo + interacciones. |
| PATCH  | `/api/leads/:id`                | sesión           | Estado, asignación, próxima acción, intentos, `no_contactar`… Envía `updated_at` para detectar ediciones simultáneas (409). |
| DELETE | `/api/leads/:id`                | admin            | Si está en «no contactar» exige `?force=1`. |
| GET    | `/api/leads/:id/interactions`   | sesión           | Historial del lead. |
| POST   | `/api/leads/:id/interactions`   | sesión           | `{ tipo, resultado?, nota?, estado? }`. Una `llamada` suma un intento. |
| GET    | `/api/config`                   | sesión           | Config pública (sin secretos). |
| PUT    | `/api/config`                   | admin            | Cambia el actor de Apify (formato `usuario/actor`). |
| GET    | `/api/apify/status`             | sesión           | Valida token y actor sin gastar créditos. |
| GET    | `/api/ai/status`                | público          | Indica si el servidor tiene IA y qué modelo usa. |
| POST   | `/api/ai`                       | sesión           | Genera el copy JSON de la demo (30 / 10 min por usuario). |
| POST   | `/api/enrich`                   | sesión           | Analiza hasta 3 enlaces públicos (20 / 10 min por usuario). |

### Permisos sobre leads

- **admin y supervisor** ven y reasignan todos los leads; solo ellos pueden
  quitar «no contactar». Solo **admin** borra.
- **comercial y soporte** ven sus leads y los que no tienen asignar. Los que
  importan quedan asignados a ellos y solo pueden asignarse leads libres.

### Deduplicación al importar (`POST /api/leads`)

1. **Mismo `place_id`** → es la misma ficha: se refrescan nombre, rating,
   reseñas, horario, etc. (los campos vacíos no borran lo que había).
2. **Mismo teléfono** (normalizado, sin `+34`) → se devuelve el lead
   existente sin mezclar datos.
3. Si no, se crea con un UUID del servidor.

En los casos 1 y 2 **nunca** se tocan estado, asignación, intentos, próxima
acción ni `no_contactar`. La respuesta trae `duplicate: true` y el estado
actual, y el frontend lo adopta (por ejemplo, marca «no contactar» un lead que
otro comercial ya excluyó).

`POST /api/search` acepta `{ actor?, input?, params?, persist? }`. Si envías
`params` (`{ sector, zona, max }`), el servidor construye el input del actor.

## Inteligencia artificial

La demo web y el análisis de fuentes funcionan de dos formas:

1. **Backend (recomendado).** Define `OPENAI_API_KEY` (y opcionalmente
   `OPENAI_BASE_URL` y `OPENAI_MODEL`) en el servidor. El navegador llama a
   `/api/ai` y `/api/enrich`; la clave nunca llega al cliente. Compatible con
   OpenAI, Groq, Together, Ollama o LM Studio.
2. **Navegador.** En **Administración → Configuración → Inteligencia artificial**
   puedes guardar un endpoint compatible y una clave en `localStorage`. Solo se
   usa si no hay backend configurado. El análisis de enlaces requiere backend.

El prompt incluye instrucciones anti-invención: los datos dudosos se marcan
como `[POR CONFIRMAR]` y la IA debe basarse en la ficha, Google Maps y las
fuentes públicas analizadas.

## Conectar Google Maps (Apify) y captar leads

El desk de captación pide a Google Maps **solo negocios sin web propia** (sin
web o únicamente con redes sociales) y los convierte en leads. Hay dos formas
de conectar la fuente:

1. **Token en el navegador (rápido).** Entra como administrador en
   **Administración → Configuración**, pega tu token de Apify
   (`apify_api_…`, se crea en
   <https://console.apify.com/account/integrations>) y pulsa
   **Probar conexión**. El token queda en `localStorage` de ese navegador:
   nunca se escribe en `index.html` ni se incluye en las exportaciones.
2. **Backend (producción).** Define `APIFY_TOKEN` en el servidor (o en
   Railway → Variables) y pon la URL del backend en Configuración. El token
   no llega al navegador; los leads se guardan además en PostgreSQL.

La búsqueda envía al actor `compass/crawler-google-places`:

```json
{
  "searchStringsArray": ["Clínica dental Málaga"],
  "locationQuery": "Málaga, España",
  "countryCode": "es",
  "city": "Málaga",
  "maxCrawledPlacesPerSearch": 10,
  "language": "es",
  "website": "withoutWebsite",
  "skipClosedPlaces": true
}
```

- **Prueba (10)** fija 10 resultados y la zona indicada para gastar pocos
  créditos. La cobertura por provincias lanza 52 consultas y puede tardar.
- El cliente descarta los negocios con web propia, los duplicados por
  `place_id` o teléfono y los que quedan fuera de España.
- **Sin token:** exporta el dataset del actor en JSON desde Apify y pégalo en
  **Motor de búsqueda → Importar dataset de Apify**. Se aplican los mismos
  filtros y no consume créditos.
- Si Apify rechaza el filtro `website`, se reintenta una vez sin él y el
  filtrado se hace igualmente en local.

## Puesta en marcha local

### Opción A — Docker Compose (recomendada)

Requisitos: Docker Desktop.

```bash
cp server/.env.example server/.env   # opcional: rellena APIFY_TOKEN
docker compose up --build
```

- API + frontend: http://localhost:3000
- PostgreSQL: `localhost:5432` (usuario/clave `crm`).

### Opción B — manual

Requisitos: Node 20+ y un PostgreSQL accesible.

```bash
cd server
cp .env.example .env                 # rellena DATABASE_URL y APIFY_TOKEN
npm install
npm run dev                          # ts-node-dev, recarga en caliente
```

`index.html` se sirve desde la raíz del proyecto (o ábrelo directamente;
configura la URL del API en **Administración → Configuración**).

## Despliegue en Railway

1. Crea un proyecto y añade el plugin **PostgreSQL**. Railway inyecta
   `DATABASE_URL` automáticamente.
2. Sube este repositorio (`railway up`, o conecta el repo de GitHub).
   `railway.json` ya indica el `server/Dockerfile` y el healthcheck `/health`.
3. En **Variables** del servicio define:
   - `AUTH_SECRET` — cadena aleatoria de 32+ caracteres (obligatoria).
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD` — crean el primer admin al arrancar
     (contraseña de 10+ caracteres). Después puedes quitarlas.
   - `APIFY_TOKEN` — tu token privado (obligatorio para búsquedas reales).
   - `APIFY_DEFAULT_ACTOR` — opcional, por defecto `compass/crawler-google-places`.
   - `CORS_ORIGIN` — tu dominio público, p. ej. `https://tu-app.up.railway.app`.
4. El mismo servicio sirve el frontend y el API. Abre la URL pública y, en
   **Administración → Configuración**, pon esa URL en *Backend / API URL* e
   **inicia sesión** con tu usuario del servidor.
5. Crea al resto del equipo con `POST /api/users`, usando los mismos ids que
   el frontend (`u2`, `u3`…), para que las asignaciones coincidan.

### Actualizar desde la 1.1.x

La migración es automática al arrancar (añade `users`, `lead_interactions` y
columnas nuevas; no borra datos). Antes de subirla define `AUTH_SECRET`,
`ADMIN_EMAIL` y `ADMIN_PASSWORD`: sin usuario, la API responde 401 a todo.
Los leads que ya estén en la BD conservan su id. Si dos navegadores llegaron a
pisarse en la 1.1.x, esas pérdidas no se pueden recuperar desde el servidor;
los datos de cada navegador siguen en su copia local.

> El token de Apify **nunca** se guarda en `index.html` ni se envía al navegador:
> sólo existe en las variables de entorno del servidor.

## Pruebas

```bash
cd server
TEST_DATABASE_URL=postgres://crm:crm@localhost:5432/crm_test npm test
```

Usa una base de datos **solo para pruebas**: borra y recrea las tablas.
Cubren login y permisos, que el servidor no se cae con datos erróneos, la
deduplicación, que reimportar no resetea «no contactar», importaciones
simultáneas, ediciones simultáneas (409) e interacciones. Apify se simula
con un servidor local, así que no gastan créditos.

## Notas y trabajo pendiente

- **El frontend aún trabaja en local.** Envía los leads al importar y adopta
  el estado del servidor, pero los cambios del día a día (llamadas, estados)
  siguen guardándose en el navegador. El siguiente paso es que lea y escriba
  en `GET/PATCH /api/leads` y use `localStorage` solo como caché.

- **PostGIS** queda pospuesto (fase 2); por ahora se usan columnas `lat`/`lng`.
- **Telefonía** aún no está implementada (adaptadores preparados en el
  frontend). El login del frontend sigue siendo de demostración; el del
  backend es el que protege los datos.
- La búsqueda es síncrona (`run-sync-get-dataset-items`). Para volúmenes
  grandes, en fase 2 se moverá a un modo asíncrono con colas (Redis + BullMQ).
- Sin `APIFY_TOKEN` ni URL de backend no se generan leads de prueba: la
  interfaz avisa y el importador de datasets permite seguir trabajando con
  exportaciones reales de Apify.
