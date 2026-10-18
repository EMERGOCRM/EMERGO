# CRM multi-escritorio — backend y despliegue

Prototipo de CRM para captar y digitalizar negocios sin presencia online.
Este repositorio contiene el frontend estático (`index.html`) **y** el API
(Node + TypeScript + Express + PostgreSQL) que lo alimenta.

## Versión

**Versión actual: 1.0.0** (18/10/2026)

- Se muestra en la app (sidebar, login y Configuración) y en `VERSION`.
- Antes de generar cada ZIP, sube la versión en **los cuatro sitios**:
  `index.html` (`APP_VERSION` y `APP_RELEASE`), `VERSION`, este README y
  `server/package.json`.
- Nombra el ZIP con la versión, por ejemplo: `crm-captacion-v1.0.0.zip`.

### Historial

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
│  │  └─ routes/         # search, leads, config
│  ├─ Dockerfile
│  ├─ .env.example
│  └─ Procfile
├─ docker-compose.yml    # API + PostgreSQL para desarrollo local
└─ railway.json          # despliegue en Railway (builder Dockerfile)
```

## API

| Método | Ruta               | Descripción                                             |
| ------ | ------------------ | ------------------------------------------------------- |
| GET    | `/health`          | Estado del servicio, BD y Apify.                        |
| POST   | `/api/search`      | Ejecuta el actor de Apify. El token vive en el servidor.|
| POST   | `/api/leads`       | Inserta/actualiza leads (array o `{ leads: [] }`).      |
| GET    | `/api/leads`       | Lista leads (`?estado=&asignado_a=&limit=&offset=`).    |
| GET    | `/api/leads/:id`   | Devuelve un lead.                                       |
| GET    | `/api/config`      | Config pública (sin secretos).                          |
| PUT    | `/api/config`      | Actualiza el actor de Apify (tabla `settings`).         |

`POST /api/search` acepta `{ actor?, input?, params?, persist? }`. Si envías
`params` (`{ sector, zona, max }`), el servidor construye el input del actor.

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
  "countryCode": "ES",
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
   - `APIFY_TOKEN` — tu token privado (obligatorio para búsquedas reales).
   - `APIFY_DEFAULT_ACTOR` — opcional, por defecto `compass/crawler-google-places`.
   - `CORS_ORIGIN` — tu dominio público, p. ej. `https://tu-app.up.railway.app`.
4. El mismo servicio sirve el frontend y el API. Abre la URL pública y, en
   **Administración → Configuración**, pon esa URL en *Backend / API URL*.

> El token de Apify **nunca** se guarda en `index.html` ni se envía al navegador:
> sólo existe en las variables de entorno del servidor.

## Notas y trabajo pendiente

- **PostGIS** queda pospuesto (fase 2); por ahora se usan columnas `lat`/`lng`.
- **Autenticación JWT** y **telefonía** aún no están implementadas (adaptadores
  preparados en el frontend).
- La búsqueda es síncrona (`run-sync-get-dataset-items`). Para volúmenes
  grandes, en fase 2 se moverá a un modo asíncrono con colas (Redis + BullMQ).
- Sin `APIFY_TOKEN` ni URL de backend no se generan leads de prueba: la
  interfaz avisa y el importador de datasets permite seguir trabajando con
  exportaciones reales de Apify.
