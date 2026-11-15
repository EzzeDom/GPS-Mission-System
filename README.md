# GPS Mission Control — Primera base funcional

Proyecto independiente. Panel Next.js + Supabase para gestionar grupos, miembros y asignar misiones selectivamente. **Esta etapa NO envía notificaciones push y NO tiene rutas GPS reales**. Los puntos son etiquetas descriptivas.

1. `npm install`
2. Crear un proyecto Supabase nuevo, ejecutar `supabase/01_schema.sql` en SQL Editor.
3. Copiar `.env.local.example` a `.env.local` y completar URL y publishable key de Supabase.
4. En Supabase Authentication > Users, crear las cuentas de prueba (con correo confirmado).
5. Promover TU correo con este SQL (cambiar el correo por el real):

```sql
update public.profiles p set role = 'admin'
from auth.users u
where p.id = u.id and u.email = 'TU_CORREO@EJEMPLO.COM';
```

6. `npm run dev` y abrir `http://localhost:3000`.
7. Iniciar sesión como admin, crear grupos, asignar usuarios y registrar una misión para un grupo.
8. **Antes de producción**: pruebas de seguridad RLS, validaciones, roles más finos, scheduler, ubicación GPS real, apps móviles y push.

No usar claves secretas ni service_role en archivos `NEXT_PUBLIC_`.
