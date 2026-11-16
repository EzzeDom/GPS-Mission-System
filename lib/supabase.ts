import { createClient } from "@supabase/supabase-js";

// Esta clave es PUBLICABLE; nunca usar service_role ni secret en el navegador.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
);
