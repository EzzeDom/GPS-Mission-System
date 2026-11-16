# Activación pendiente

## Migraciones aplicadas en la base GPS

1. `20261116015511_mission_lifecycle.sql`: añade release_at/request_id, eventos, funciones de ciclo de misión, restricciones de lectura por actividad/horario/aceptación y publicación Realtime de respuestas y eventos. Mantiene assign_mission para compatibilidad. Revoca la ejecución pública del trigger de alta de perfiles.
2. `20261116015540_push_delivery.sql`: añade dispositivos y entregas, RLS y una función de reclamación de lotes exclusiva de service_role.

No eliminan grupos, usuarios ni misiones existentes. Los destinatarios de misiones antiguas deberán aceptar antes de leer coordenadas. Los administradores conservan acceso. No ejecutar una reversión automática que quite restricciones de seguridad; revertir el código del panel no exige eliminar estas tablas.

Tras autorización explícita del usuario, ambas migraciones se aplicaron con éxito. Se conservaron 2 perfiles, 2 grupos, 2 misiones, 3 destinatarios y 4 destinos; las 9 tablas tienen RLS activo. Las restricciones de lectura para una identidad ajena y la visibilidad administrativa se comprobaron dentro de una transacción revertida. El SQL se ejecutó con éxito en PostgreSQL embebido PGlite usando fixtures ficticios y roles anon/authenticated/service_role. Estas pruebas no sustituyen pruebas de Supabase Auth, Realtime y dispositivos reales.

## Servicios móviles

- Proyecto Expo propio para GPS Mission System; definir `EXPO_PUBLIC_EAS_PROJECT_ID`.
- Credenciales FCM v1 para Android y APNs para iOS, configuradas en Expo de forma segura. No incluir claves privadas en Git.
- Google Cloud propio: Maps SDK for Android/iOS y claves restringidas al paquete `com.ezzedom.gpsmission` y sus certificados/bundle ID. No habilitar facturación ni servicios pagos sin aprobación.
- Compilación de desarrollo Android/iOS. EAS y las cuentas de distribución pueden requerir autorización o pago; no se iniciaron compilaciones remotas.

## Worker y horario

Con la base actualizada: desplegar `supabase/functions/dispatch-push` con `PUSH_WORKER_SECRET` aleatorio de al menos 32 bytes. El endpoint desactiva la verificación JWT de plataforma porque comprueba ese secreto dedicado. SUPABASE_SERVICE_ROLE_KEY solo se usa en el servidor. Opcional: EXPO_ACCESS_TOKEN si Expo tiene seguridad push habilitada.

Configurar un scheduler autenticado cada minuto para POST a `/functions/v1/dispatch-push` con `Authorization: Bearer <PUSH_WORKER_SECRET>`. Mantener el secreto en Vault/gestor de secretos, nunca en el SQL versionado ni en el cliente. Todavía no está configurado.

La cola reclama hasta 50 envíos por invocación con bloqueo y sin duplicados. Comprueba cuenta, asignación, hora y dispositivo antes de enviar. El contenido push es genérico, sin coordenadas ni instrucciones. Las respuestas inciertas y HTTP 5xx quedan en `uncertain`; revisar manualmente antes de reenviar. HTTP 4xx queda en `failed`; corregir configuración antes de reactivar cualquier entrega. Los receipts se consultan después de 15 minutos. Los tokens DeviceNotRegistered se eliminan. Un fallo de escritura posterior a un envío deja el trabajo `sending` y pasa a `uncertain` tras 10 minutos, evitando un reenvío ciego.

## Prueba de extremo a extremo pendiente

Con tres cuentas de prueba propias: A en dos grupos, B en uno y C fuera de ambos. Registrar Android/iPhone, crear una misión para un grupo y A individualmente. Verificar una entrega por dispositivo, exclusión de C, aceptación/rechazo, destinos bloqueados, avance repetido, cancelación y desactivación. Repetir con app abierta, en segundo plano y cerrada. Comprobar tickets, receipts y recepción visible por separado. Probar una misión programada y una pérdida de conexión durante el envío.

## Avisos del asesor

Permanece el aviso sobre la función heredada assign_mission (SECURITY DEFINER): conserva una comprobación de administrador activo y se mantiene para compatibilidad con el panel anterior. [Referencia](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). La protección de contraseñas filtradas sigue desactivada; no se cambió el plan ni la configuración de Auth. [Referencia](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
