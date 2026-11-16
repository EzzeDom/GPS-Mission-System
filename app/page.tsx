"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowRight, Check, CircleDot, ClipboardList, LockKeyhole,
  LogOut, Plus, Radar, RadioTower, RefreshCcw, Route, Send,
  ShieldCheck, Trash2, UsersRound, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

type Profile = { id: string; display_name: string; role: string; active: boolean };
type Group = { id: string; name: string; created_at: string };
type Member = { group_id: string; user_id: string };
type Mission = { id: string; title: string; status: string; progressive: boolean; created_at: string; release_at: string };
type Recipient = { mission_id: string; user_id: string; state: string; unlocked_step: number };
type MissionEvent = { id: number; mission_id: string; kind: string; created_at: string };
type Target = "groups" | "individual" | "mixed" | "all";

export default function Home() {
  const requestId = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"dashboard" | "groups" | "missions">("dashboard");

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [assignments, setAssignments] = useState<Recipient[]>([]);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [detailId, setDetailId] = useState("");
  const [releaseAt, setReleaseAt] = useState("");
  const [coordinates, setCoordinates] = useState<Record<number, {latitude: string; longitude: string}>>({});
  const [selectedGroup, setSelectedGroup] = useState("");
  const [newGroup, setNewGroup] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pointText, setPointText] = useState("Punto inicial\nDestino final");
  const [target, setTarget] = useState<Target>("groups");
  const [targetGroups, setTargetGroups] = useState<string[]>([]);
  const [targetUsers, setTargetUsers] = useState<string[]>([]);
  const [progressive, setProgressive] = useState(true);

  const points = pointText.split("\n").map(x => x.trim()).filter(Boolean);
  const activeIds = useMemo(() => new Set(profiles.filter(p => p.active).map(p => p.id)), [profiles]);
  const recipients = useMemo(() => {
    const fromGroups = members.filter(m => targetGroups.includes(m.group_id)).map(m => m.user_id);
    const raw = target === "all" ? [...activeIds]
      : target === "groups" ? fromGroups
      : target === "individual" ? targetUsers
      : [...fromGroups, ...targetUsers];
    return [...new Set(raw)].filter(id => activeIds.has(id));
  }, [members, targetGroups, targetUsers, target, activeIds]);

  const selected = groups.find(g => g.id === selectedGroup);
  const selectedMembers = members.filter(m => m.group_id === selectedGroup).map(m => m.user_id);

  const loadData = useCallback(async () => {
    const [p, g, gm, m, r, ev] = await Promise.all([
      supabase.from("profiles").select("id,display_name,role,active").order("display_name"),
      supabase.from("groups").select("id,name,created_at").order("name"),
      supabase.from("group_members").select("group_id,user_id"),
      supabase.from("missions").select("id,title,status,progressive,created_at,release_at")
        .order("created_at", { ascending: false }).limit(30),
      supabase.from("mission_recipients").select("mission_id,user_id,state,unlocked_step"),
      supabase.from("mission_events").select("id,mission_id,kind,created_at").order("created_at", {ascending:false}).limit(100),
    ]);
    const failed = [p.error, g.error, gm.error, m.error, r.error, ev.error].find(Boolean);
    if (failed) { setError(failed.message); return; }
    setProfiles((p.data || []) as Profile[]);
    setGroups((g.data || []) as Group[]);
    setMembers((gm.data || []) as Member[]);
    setMissions((m.data || []) as Mission[]);
    setAssignments((r.data || []) as Recipient[]);
    setEvents((ev.data || []) as MissionEvent[]);
    setSelectedGroup(prev => (g.data || []).some(item => item.id === prev) ? prev : (g.data?.[0]?.id || ""));
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    const { data, error: authError } = await supabase.auth.getUser();
    if (authError || !data.user) {
      setUserId(null); setAdmin(false); setLoading(false); return;
    }
    setUserId(data.user.id);
    const result = await supabase.from("profiles")
      .select("role, active").eq("id", data.user.id).single();
    const allowed = result.data?.role === "admin" && result.data.active === true;
    setAdmin(allowed);
    if (allowed) await loadData();
    setLoading(false);
  }, [loadData]);

  useEffect(() => { const timer = setTimeout(() => { void bootstrap(); }, 0); return () => clearTimeout(timer); }, [bootstrap]);

  useEffect(() => {
    if (!admin) return;
    const channel = supabase.channel("control-events").on("postgres_changes", {event:"*",schema:"public",table:"mission_recipients"}, () => { void loadData(); }).on("postgres_changes", {event:"INSERT",schema:"public",table:"mission_events"}, () => { void loadData(); }).subscribe();
    const timer = setInterval(() => { void loadData(); }, 30000);
    return () => { clearInterval(timer); void supabase.removeChannel(channel); };
  }, [admin, loadData]);

  async function setActive(profile: Profile) {
    setBusy(true); setError("");
    try {
      const {error} = await supabase.rpc("set_user_active", {p_user_id:profile.id,p_active:!profile.active});
      if (error) throw error;
      await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : String((e as {message?:string}).message || e)); }
    finally { setBusy(false); }
  }

  async function cancelMission() {
    if (!window.confirm("¿Cancelar esta misión y bloquear el acceso de sus destinatarios?")) return;
    setBusy(true); setError("");
    try { const {error}=await supabase.rpc("cancel_mission",{p_mission_id:detailId}); if(error)throw error; await loadData(); }
    catch(e){setError(String((e as {message?:string}).message || e));} finally {setBusy(false);}
  }

  async function advance(recipient: Recipient) {
    setBusy(true); setError("");
    try {
      const {error} = await supabase.rpc("advance_recipient", {p_mission_id:recipient.mission_id,p_user_id:recipient.user_id,p_expected_step:recipient.unlocked_step});
      if (error) throw error;
      await loadData();
    } catch (e) { setError(String((e as {message?:string}).message || e)); }
    finally { setBusy(false); }
  }

  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
    else await bootstrap();
    setBusy(false);
  }

  async function logout() {
    await supabase.auth.signOut();
    setUserId(null); setAdmin(false); setNotice(""); setError("");
  }

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    if (!userId || newGroup.trim().length < 2) return;
    setBusy(true); setError("");
    const { data, error: err } = await supabase.from("groups")
      .insert({ name: newGroup.trim(), created_by: userId }).select("id").single();
    if (err) setError(err.message);
    else { setNewGroup(""); setSelectedGroup(data.id); await loadData(); setNotice("Grupo creado."); }
    setBusy(false);
  }

  async function deleteGroup(group: Group) {
    if (!window.confirm(`¿Eliminar ${group.name}? Sus asignaciones de miembros se perderán.`)) return;
    setBusy(true); setError("");
    const { error: err } = await supabase.from("groups").delete().eq("id", group.id);
    if (err) setError(err.message);
    else {
      if (selectedGroup === group.id) setSelectedGroup("");
      setTargetGroups(old => old.filter(id => id !== group.id));
      await loadData(); setNotice("Grupo eliminado. Las misiones ya asignadas no cambian.");
    }
    setBusy(false);
  }

  async function toggleMember(profileId: string) {
    if (!selectedGroup) return;
    setBusy(true); setError("");
    const present = selectedMembers.includes(profileId);
    const result = present
      ? await supabase.from("group_members").delete().eq("group_id", selectedGroup).eq("user_id", profileId)
      : await supabase.from("group_members").insert({ group_id: selectedGroup, user_id: profileId });
    if (result.error) setError(result.error.message);
    else await loadData();
    setBusy(false);
  }

  function toggle(value: string, list: string[], setter: (v: string[]) => void) {
    setter(list.includes(value) ? list.filter(x => x !== value) : [...list, value]);
  }

  async function assignMission(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || points.length < 2 || recipients.length === 0) return;
    if (points.some((_,i) => !coordinates[i]?.latitude?.trim() || !coordinates[i]?.longitude?.trim() || !Number.isFinite(Number(coordinates[i].latitude)) || !Number.isFinite(Number(coordinates[i].longitude)) || Math.abs(Number(coordinates[i].latitude))>90 || Math.abs(Number(coordinates[i].longitude))>180)) { setError("Completá coordenadas válidas para cada destino."); return; }
    setBusy(true); setError(""); setNotice("");
    requestId.current ||= crypto.randomUUID();
    const { data, error: err } = await supabase.rpc("create_mission", {
      p_request_id: requestId.current,
      p_title: title.trim(), p_description: description.trim(), p_points: points.map((label,index) => ({label,latitude:Number(coordinates[index]?.latitude),longitude:Number(coordinates[index]?.longitude)})),
      p_release_at: releaseAt ? new Date(releaseAt).toISOString() : null,
      p_group_ids: target === "groups" || target === "mixed" ? targetGroups : [],
      p_user_ids: target === "individual" || target === "mixed" ? targetUsers : [],
      p_all_users: target === "all", p_progressive: progressive,
    });
    if (err) setError(err.message);
    else {
      requestId.current = null;
      setTitle(""); setDescription("");
      setNotice(`Misión ${String(data).slice(0, 8)} asignada a ${recipients.length} usuario(s) en Supabase. No se envió ningún push.`);
      await loadData(); setTab("dashboard");
    }
    setBusy(false);
  }

  if (loading) return <main className="center"><Radar className="spin" size={42}/><p>Conectando con Mission Control...</p></main>;
  if (!userId) return <main className="center"><form className="login panel" onSubmit={login}>
    <RadioTower size={44} className="cyan"/><div className="eyebrow">GPS MISSION SYSTEM</div>
    <h1>MISSION CONTROL</h1><p className="muted">Acceso exclusivo del centro de operaciones.</p>
    <label>Correo electrónico<input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="operador@ejemplo.com"/></label>
    <label>Contraseña<input type="password" required value={password} onChange={e => setPassword(e.target.value)}/></label>
    {error && <p className="error">{error}</p>}
    <button disabled={busy} className="primary">{busy ? "Ingresando..." : "ACCEDER AL PANEL"} <ArrowRight size={17}/></button>
  </form></main>;
  if (!admin) return <main className="center"><div className="panel login">
    <LockKeyhole className="red" size={42}/><h1>ACCESO RESTRINGIDO</h1>
    <p className="muted">Tu cuenta existe, pero todavía no tiene permisos de administrador.</p>
    <button className="secondary" onClick={logout}>Cerrar sesión</button>
  </div></main>;

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><RadioTower className="cyan" size={30}/><div><strong>MISSION CONTROL</strong><span>GPS SYSTEM / ADMIN</span></div></div>
      <div className="online"><CircleDot size={13}/> PANEL CONECTADO</div>
      <nav>
        <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}><Activity size={18}/> Centro de control</button>
        <button className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}><UsersRound size={18}/> Grupos privados</button>
        <button className={tab === "missions" ? "active" : ""} onClick={() => setTab("missions")}><Route size={18}/> Crear misión</button>
      </nav>
      <div className="sidebarBottom"><p>CONTROL / MISIONES</p><button onClick={logout}><LogOut size={17}/> Cerrar sesión</button></div>
    </aside>
    <main className="content">
      <header className="top"><div><span className="eyebrow">OPERATIONS / CONTROL CENTER</span><h1>{tab === "dashboard" ? "Centro de operaciones" : tab === "groups" ? "Grupos y miembros" : "Nueva misión"}</h1></div>
        <button className="secondary" disabled={busy} onClick={() => void loadData()}><RefreshCcw size={16}/> Actualizar</button></header>
      {error && <div className="message error"><X size={16}/>{error}<button onClick={() => setError("")}>Cerrar</button></div>}
      {notice && <div className="message ok"><Check size={16}/>{notice}<button onClick={() => setNotice("")}>Cerrar</button></div>}

      {tab === "dashboard" && <>
        <div className="stats"><div className="panel stat"><UsersRound className="cyan"/><strong>{profiles.length}</strong><span>Usuarios registrados</span></div>
          <div className="panel stat"><ShieldCheck className="cyan"/><strong>{groups.length}</strong><span>Grupos privados</span></div>
          <div className="panel stat"><ClipboardList className="cyan"/><strong>{missions.length}</strong><span>Últimas misiones</span></div></div>
        <section className="panel"><div className="sectionHead"><div><div className="eyebrow">TRANSMISIONES REGISTRADAS</div><h2>Misiones asignadas</h2></div><button className="primary" onClick={() => setTab("missions")}><Plus size={17}/> Nueva misión</button></div>
          {missions.length ? missions.map(m => <div className="missionRow" key={m.id}><div className="missionIcon"><Route size={19}/></div><div className="grow"><button className="secondary" onClick={() => setDetailId(detailId === m.id ? "" : m.id)}>{m.title}</button><small>{new Date(m.created_at).toLocaleString("es-AR")} · ID {m.id.slice(0, 8)}</small></div><span className="tag">{new Date(m.release_at)>new Date() ? "PROGRAMADA" : m.status === "assigned" ? "ASIGNADA" : m.status.toUpperCase()}</span></div>)
            : <p className="muted">Todavía no hay misiones. Creá la primera desde el editor.</p>}
        </section>
        {detailId && <section className="panel"><h2>Supervisión de misión</h2><button className="secondary" disabled={busy || missions.find(m=>m.id===detailId)?.status!=="assigned"} onClick={()=>void cancelMission()}>Cancelar misión</button>
          <p className="muted">El operador confirma cada etapa. Repetir una solicitud no desbloquea dos destinos.</p>
          {assignments.filter(r => r.mission_id===detailId).map(r => <div className="missionRow" key={r.user_id}><div className="grow"><strong>{profiles.find(p=>p.id===r.user_id)?.display_name || r.user_id}</strong><small>{r.state} · Paso {r.unlocked_step}</small></div><button disabled={busy || r.state!=="accepted"} className="secondary" onClick={()=>void advance(r)}>Confirmar etapa</button></div>)}
          <h3>Registro de eventos</h3>{events.filter(e=>e.mission_id===detailId).map(e=><p key={e.id} className="muted">{new Date(e.created_at).toLocaleString("es-AR")} · {e.kind}</p>)}
        </section>}
        <section className="panel"><h2>Usuarios autorizados</h2>{profiles.map(p=><div className="missionRow" key={p.id}><div className="grow"><strong>{p.display_name}</strong><small>{p.role} · {p.active ? "Activo" : "Inactivo"}</small></div><button className="secondary" disabled={busy || p.id===userId} onClick={()=>void setActive(p)}>{p.active ? "Desactivar" : "Activar"}</button></div>)}</section>
        <div className="panel info"><ShieldCheck className="cyan"/><p>Los destinos se protegen en el servidor. El envío push requiere activar el servicio de entrega y registrar los teléfonos.</p></div>
      </>}

      {tab === "groups" && <div className="columns"><section className="panel"><div className="eyebrow">SEGMENTACIÓN</div><h2>Grupos privados</h2>
        <form className="inlineForm" onSubmit={createGroup}><input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="Nombre del nuevo grupo" minLength={2} maxLength={80} required/><button className="primary" disabled={busy}><Plus size={18}/> Crear</button></form>
        <div className="groupList">{groups.map(g => <div key={g.id} className={`groupRow ${selectedGroup === g.id ? "chosen" : ""}`}>
          <button className="groupSelect" onClick={() => setSelectedGroup(g.id)}><UsersRound size={18}/><span>{g.name}<small>{members.filter(m => m.group_id === g.id).length} integrantes</small></span></button>
          <button title="Eliminar grupo" className="iconBtn" disabled={busy} onClick={() => void deleteGroup(g)}><Trash2 size={16}/></button>
        </div>)}{groups.length === 0 && <p className="muted">Todavía no hay grupos.</p>}</div>
      </section>
      <section className="panel"><div className="eyebrow">ASIGNACIONES</div><h2>{selected?.name || "Seleccioná un grupo"}</h2>
        <p className="muted">Activá o desactivá integrantes. Una persona puede pertenecer a varios grupos.</p>
        {selected && profiles.map(p => <label className="userRow" key={p.id}><div><strong>{p.display_name}</strong><small>{p.role === "admin" ? "Administrador" : "Usuario"}{!p.active ? " · Inactivo" : ""}</small></div>
          <input type="checkbox" checked={selectedMembers.includes(p.id)} disabled={busy || (!p.active && !selectedMembers.includes(p.id))} onChange={() => void toggleMember(p.id)}/></label>)}
        {!profiles.length && <p className="muted">Creá usuarios en Supabase Auth para poder agregarlos.</p>}
      </section></div>}

      {tab === "missions" && <form onSubmit={assignMission} className="columns"><section className="panel"><div className="eyebrow">01 / CONFIGURACIÓN</div><h2>Información y recorrido</h2>
        <label>Nombre de la misión<input required minLength={3} maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="Operación Aurora"/></label>
        <label>Instrucciones visibles<textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="Indicaciones para los participantes"/></label>
        <label>Puntos del recorrido (uno por línea)<textarea rows={5} value={pointText} onChange={e => setPointText(e.target.value)} /></label>
        {points.map((label,i)=><div className="panel" key={i}><strong>{i+1}. {label}</strong><label>Latitud<input type="number" step="any" min={-90} max={90} required value={coordinates[i]?.latitude || ""} onChange={e=>setCoordinates(old=>({...old,[i]:{latitude:e.target.value,longitude:old[i]?.longitude || ""}}))}/></label><label>Longitud<input type="number" step="any" min={-180} max={180} required value={coordinates[i]?.longitude || ""} onChange={e=>setCoordinates(old=>({...old,[i]:{latitude:old[i]?.latitude || "",longitude:e.target.value}}))}/></label></div>)}
        <label>Liberación de la misión (hora local, vacío = ahora)<input type="datetime-local" value={releaseAt} onChange={e=>setReleaseAt(e.target.value)}/></label>
        <label className="checkRow"><input type="checkbox" checked={progressive} onChange={e => setProgressive(e.target.checked)}/><span>Desbloqueo progresivo de destinos</span></label>
      </section><section className="panel"><div className="eyebrow">02 / DESTINATARIOS</div><h2>Distribución selectiva</h2>
        <div className="targetModes">{([ ["groups","Grupos seleccionados"],["individual","Usuarios específicos"],["mixed","Grupos + usuarios"],["all","Todos los activos"] ] as const).map(([value,label]) => <label key={value} className={target === value ? "selectedMode" : ""}><input type="radio" checked={target === value} onChange={() => setTarget(value)}/>{label}</label>)}</div>
        {(target === "groups" || target === "mixed") && <><h3>Grupos</h3>{groups.map(g => <label className="userRow" key={g.id}><span>{g.name}<small>{members.filter(m => m.group_id === g.id).length} integrantes</small></span><input type="checkbox" checked={targetGroups.includes(g.id)} onChange={() => toggle(g.id,targetGroups,setTargetGroups)}/></label>)}</>}
        {(target === "individual" || target === "mixed") && <><h3>Usuarios</h3>{profiles.filter(p => p.active).map(p => <label className="userRow" key={p.id}><span>{p.display_name}</span><input type="checkbox" checked={targetUsers.includes(p.id)} onChange={() => toggle(p.id,targetUsers,setTargetUsers)}/></label>)}</>}
        <div className="recipientCounter"><UsersRound/><div><strong>{recipients.length}</strong><span>Destinatarios únicos</span></div></div>
        <button type="submit" className="primary full" disabled={busy || title.trim().length < 3 || points.length < 2 || points.length > 30 || recipients.length === 0}><Send size={18}/>{busy ? "Guardando..." : "ASIGNAR MISIÓN EN BASE DE DATOS"}</button>
        <p className="hint"><LockKeyhole size={15}/> La asignación no dispara alertas push. Solo los destinatarios autorizados podrán consultar la misión.</p>
      </section></form>}
    </main>
  </div>;
}
