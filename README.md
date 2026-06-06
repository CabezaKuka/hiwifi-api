# HI-WIFI API

## Estructura
```
hiwifi-api/
├── server.js          # API + rutas
├── public/
│   └── index.html     # Dashboard del cliente
├── package.json
├── .env.example
└── README.md
```

## Endpoints

| Método | Ruta           | Quién la llama     | Qué hace                        |
|--------|----------------|--------------------|---------------------------------|
| POST   | /datos         | ESP-01             | Guarda lectura de temp + hum    |
| GET    | /api/:codigo   | Dashboard JS       | Devuelve lecturas del dispositivo |
| GET    | /              | Navegador cliente  | Sirve el dashboard HTML         |
| GET    | /health        | Railway healthcheck | Confirma que el servidor vive  |

## Body del ESP-01 (POST /datos)
```json
{ "token": "tok_c3d4e5f6a1b2", "temperature": 24.35, "humidity": 61.40 }
```

## Deploy en Railway
1. Subir este directorio a un repo GitHub
2. New Project → Deploy from GitHub repo
3. Variables: DATABASE_URL (Railway la provee automáticamente si agregás PostgreSQL)
4. El deploy es automático en cada push

## Desarrollo local
```bash
npm install
cp .env.example .env   # completar DATABASE_URL
npm run dev
```
