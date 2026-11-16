# GPS Mission System

Proyecto independiente: centro de control Next.js, app Expo Android/iOS y Supabase. No usa infraestructura de Reckless Track ni Reckless Ride.

## Estado de esta entrega

Las dos migraciones fueron aplicadas al proyecto GPS y se verificaron conservación de datos, RLS y publicación Realtime. **El worker push y el scheduler todavía NO están desplegados.** El panel ampliado ya es compatible con el esquema activo.

- Panel original recuperado: login, grupos privados y membresía múltiple.
- Editor de misiones con coordenadas, liberación programada, destinatarios únicos e idempotencia de creación.
- Supervisión de respuestas, eventos, cancelación y confirmación administrativa de etapas.
- RLS: requiere cuenta activa, asignación, hora de liberación y aceptación para consultar destinos. Los pasos futuros no se entregan al cliente.
- App Expo: sesión en almacenamiento seguro, misiones, aceptar/rechazar, mapas Google nocturnos (requieren claves), navegación mediante Google Maps externo, actualizaciones Realtime y refresco periódico.
- Push: registro de dispositivos, cola única por misión/usuario/token, worker con secreto independiente, tickets y receipts. Un estado `delivered` significa aceptación por FCM/APNs según el receipt de Expo, **no prueba de visualización en el teléfono**.

## Desarrollo

Panel: `npm ci` y `npm run dev`. Usar `.env.local.example` como referencia para variables locales. No subir `.env.local`.

Móvil: dentro de `mobile`, `npm ci` y `npx expo start --dev-client`. Las variables están documentadas en `mobile/.env.example`. Requiere una compilación nativa para validar push y Google Maps en iOS.

Base nueva: ejecutar `supabase/01_schema.sql` una sola vez, y luego las migraciones de `supabase/migrations` en orden. Base existente de primera etapa: **no repetir 01_schema.sql**, aplicar únicamente las migraciones pendientes tras aprobación. El SDK usa solamente la clave publicable.

Pruebas: `npm run test:db`, `npm run lint`, `npm run build`; dentro de `mobile`: `npm run typecheck`, `npx expo install --check`, `npx expo export --platform android --platform ios`.

## Límites actuales

- Crear cuentas o cambiar roles sigue siendo una operación de Supabase Auth/administración; el panel activa o desactiva cuentas existentes.
- Las coordenadas se introducen manualmente en el panel; todavía no hay selección sobre un mapa web ni cálculo de rutas cian dentro de la app. La navegación giro a giro se abre en Google Maps.
- El siguiente destino se libera por confirmación del operador; no se acepta la ubicación enviada por el teléfono como prueba de llegada.
- El horario se guarda como UTC y el editor utiliza la zona horaria local del navegador. Cambiar miembros de un grupo no modifica destinatarios de misiones anteriores: son una instantánea.
- La vista puede conservar datos ya descargados hasta el próximo refresco (15 segundos en móvil); al pasar a segundo plano se limpia. Ningún sistema puede revocar una coordenada que el usuario ya vio o envió a Google Maps.
- No se promete entrega push exactamente una vez: el proveedor puede duplicar o perder entregas. La cola evita duplicados propios y pone los envíos ambiguos en `uncertain`, sin reintento automático.
- La app aún necesita pruebas en Android/iPhone físicos, claves Google Maps, proyecto Expo y credenciales FCM/APNs. No se publicaron aplicaciones ni se contrataron servicios.

Consultar [activación y verificación](docs/ACTIVATION.md).
