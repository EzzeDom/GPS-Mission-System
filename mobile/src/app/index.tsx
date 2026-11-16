import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { configured, supabase } from '../../lib/supabase';

type Mission={id:string;title:string;description:string;status:string};
type Recipient={mission_id:string;state:string;unlocked_step:number};
type Point={id:string;position:number;label:string;latitude:number|null;longitude:number|null};
const nightMap=[{elementType:'geometry',stylers:[{color:'#101a24'}]},{elementType:'labels.text.fill',stylers:[{color:'#8babc0'}]},{elementType:'labels.text.stroke',stylers:[{color:'#101a24'}]},{featureType:'road',elementType:'geometry',stylers:[{color:'#234251'}]},{featureType:'water',elementType:'geometry',stylers:[{color:'#070c16'}]}];
Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:false})});
const message=(e:unknown)=>String((e as {message?:string})?.message || e);
function Button({label,onPress,disabled=false,danger=false}:{label:string;onPress:()=>void;disabled?:boolean;danger?:boolean}){return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button,danger&&styles.danger,disabled&&{opacity:0.4}]}><Text style={styles.buttonText}>{label}</Text></Pressable>;}

export default function App(){
 const [userId,setUserId]=useState<string|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [missions,setMissions]=useState<Mission[]>([]),[recipients,setRecipients]=useState<Recipient[]>([]),[pointResult,setPointResult]=useState<{missionId:string;points:Point[]} | null>(null);
 const {missionId}=useLocalSearchParams<{missionId?:string}>();
 const selected=typeof missionId==='string' ? missionId : null;
 const setSelected=useCallback((id:string|null)=>router.setParams({missionId:id || ''}),[]);
 const [locationAllowed,setLocationAllowed]=useState(false),[foreground,setForeground]=useState(true);
 const dataEpoch=useRef(0);
 const [pulse]=useState(()=>new Animated.Value(0.35));
 const points=pointResult?.missionId===selected ? pointResult.points : [];
 const clear=useCallback(()=>{dataEpoch.current++;setMissions([]);setRecipients([]);setPointResult(null);setSelected(null);},[setSelected]);
 const refresh=useCallback(async()=>{
  if(!userId)return;
  const version=++dataEpoch.current;
  try{
   const profile=await supabase.from('profiles').select('active').eq('id',userId).single();
   if(profile.error || !profile.data?.active)throw new Error('Cuenta sin autorización activa.');
   const [m,r]=await Promise.all([supabase.from('missions').select('id,title,description,status').order('created_at',{ascending:false}),supabase.from('mission_recipients').select('mission_id,state,unlocked_step').eq('user_id',userId)]);
   if(m.error || r.error)throw m.error || r.error;
   if(version!==dataEpoch.current)return;
   setMissions(m.data || []);setRecipients(r.data || []);
  }catch(e){if(version===dataEpoch.current){clear();setError(message(e));}}
 },[userId,clear]);
 useEffect(()=>{const animation=Animated.loop(Animated.sequence([Animated.timing(pulse,{toValue:1,duration:1200,useNativeDriver:true}),Animated.timing(pulse,{toValue:0.35,duration:1200,useNativeDriver:true})]));animation.start();return()=>animation.stop();},[pulse]);
 useEffect(()=>{
  let live=true;
  supabase.auth.getSession().then(({data,error})=>{if(!live)return;if(error)setError(message(error));setUserId(data.session?.user.id || null);setLoading(false);});
  const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{clear();setUserId(session?.user.id || null);setLoading(false);});
  return()=>{live=false;subscription.unsubscribe();};
 },[clear]);
 useEffect(()=>{
  const listener=AppState.addEventListener('change',state=>{setForeground(state==='active');if(state==='active')supabase.auth.startAutoRefresh();else{supabase.auth.stopAutoRefresh();clear();}});
  return()=>listener.remove();
 },[clear]);
 useEffect(()=>{
  if(!userId || !foreground)return;
  const initial=setTimeout(()=>void refresh(),0);const timer=setInterval(()=>void refresh(),15000);
  const channel=supabase.channel(`missions-${userId}`).on('postgres_changes',{event:'*',schema:'public',table:'mission_recipients',filter:`user_id=eq.${userId}`},()=>void refresh()).subscribe();
  const notification=Notifications.addNotificationReceivedListener(()=>void refresh());
  const response=Notifications.addNotificationResponseReceivedListener(()=>void refresh());
  return()=>{clearTimeout(initial);clearInterval(timer);notification.remove();response.remove();void supabase.removeChannel(channel);};
 },[userId,foreground,refresh]);
 useEffect(()=>{
  let live=true;
  if(selected && missions.some(m=>m.id===selected))supabase.from('mission_waypoints').select('id,position,label,latitude,longitude').eq('mission_id',selected).order('position').then(({data,error})=>{if(!live)return;if(error){setError(error.message);setPointResult(null);}else setPointResult({missionId:selected,points:data || []});});
  return()=>{live=false;};
 },[selected,missions,recipients]);
 async function perform(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError(message(e));}finally{setBusy(false);}}
 async function login(){await perform(async()=>{const {error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;setPassword('');});}
 async function logout(){await perform(async()=>{
  const token=await SecureStore.getItemAsync('mission-push-token');
  if(token){const {error}=await supabase.from('push_devices').delete().eq('token',token).eq('user_id',userId!);if(error)throw new Error('No se pudo desvincular este teléfono. Reintentá con conexión.');await SecureStore.deleteItemAsync('mission-push-token');}
  const {error}=await supabase.auth.signOut();if(error)throw error;clear();setUserId(null);
 });}
 async function registerPush(){await perform(async()=>{
  if(!Device.isDevice)throw new Error('Usá un teléfono físico con una compilación de desarrollo.');
  const projectId=Constants.expoConfig?.extra?.eas?.projectId;
  if(!projectId)throw new Error('Falta vincular el proyecto de Expo para activar notificaciones.');
  if(Platform.OS==='android')await Notifications.setNotificationChannelAsync('missions',{name:'Transmisiones de misión',importance:AndroidImportance.MAX,vibrationPattern:[0,200,100,200],lightColor:'#00e5ff'});
  const permission=await Notifications.requestPermissionsAsync();if(permission.status!=='granted')throw new Error('Habilitá las notificaciones en los ajustes del teléfono.');
  const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
  const {data,error:readError}=await supabase.from('push_devices').select('token').eq('token',token).maybeSingle();if(readError)throw readError;
  if(!data){const {error}=await supabase.from('push_devices').insert({token,user_id:userId,platform:Platform.OS});if(error)throw error;}
  await SecureStore.setItemAsync('mission-push-token',token);setNotice('Teléfono registrado para alertas.');
 });}
 async function respond(accept:boolean){await perform(async()=>{const {error}=await supabase.rpc('respond_mission',{p_mission_id:selected,p_accept:accept});if(error)throw error;await refresh();});}
 async function navigate(point:Point){await perform(async()=>{
  // Fetch again under RLS immediately before handing the authorized destination to Maps.
  const {data,error}=await supabase.from('mission_waypoints').select('latitude,longitude').eq('id',point.id).single();if(error)throw error;
  if(data.latitude===null || data.longitude===null)throw new Error('Este destino todavía no tiene coordenadas.');
  await Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${data.latitude},${data.longitude}&travelmode=driving&dir_action=navigate`);
 });}
 const mission=missions.find(m=>m.id===selected),recipient=recipients.find(r=>r.mission_id===selected);
 const mapPoints=points.filter((p):p is Point&{latitude:number;longitude:number}=>p.latitude!==null && p.longitude!==null);
 const mapsConfigured=Boolean(Constants.expoConfig?.extra?.mapsConfigured?.[Platform.OS]);
 if(loading)return <View style={styles.center}><ActivityIndicator color="#00e5ff"/></View>;
 return <View style={styles.root}><StatusBar style="light"/><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
  <Animated.Text style={[styles.signal,{opacity:pulse}]}>◉ GPS MISSION SYSTEM</Animated.Text><Text style={styles.title}>{userId?'TRANSMISIONES':'ACCESO OPERATIVO'}</Text>
  {!configured && <Text style={styles.error}>Falta configurar la conexión de esta compilación.</Text>}
  {error!=='' && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}{notice!=='' && <Text style={styles.text}>{notice}</Text>}
  {!userId?<View style={styles.card}><Text style={styles.text}>Ingresá con tu cuenta autorizada.</Text><TextInput accessibilityLabel="Correo" style={styles.input} placeholder="Correo" placeholderTextColor="#78909c" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}/><TextInput accessibilityLabel="Contraseña" style={styles.input} placeholder="Contraseña" placeholderTextColor="#78909c" secureTextEntry value={password} onChangeText={setPassword}/><Button label="CONECTAR" disabled={busy||!configured} onPress={()=>void login()}/></View>:<>
   <View style={styles.toolbar}><Button label="Actualizar" disabled={busy} onPress={()=>void refresh()}/><Button label="Salir" disabled={busy} onPress={()=>void logout()}/></View>
   <Button label="ACTIVAR ALERTAS EN ESTE TELÉFONO" disabled={busy} onPress={()=>void registerPush()}/>
   {foreground && !mission && <>{missions.length===0 && <Text style={styles.text}>No hay misiones disponibles para tu cuenta.</Text>}{missions.map(m=><Pressable accessibilityRole="button" key={m.id} onPress={()=>setSelected(m.id)} style={styles.card}><Text style={styles.signal}>TRANSMISIÓN / {recipients.find(r=>r.mission_id===m.id)?.state.toUpperCase()}</Text><Text style={styles.subtitle}>{m.title}</Text><Text style={styles.text}>Abrir instrucciones →</Text></Pressable>)}</>}
   {foreground && mission && <View style={styles.card}><Button label="← Misiones" onPress={()=>setSelected(null)}/><Text style={styles.subtitle}>{mission.title}</Text><Text style={styles.text}>{mission.description}</Text>
    {recipient?.state==='pending'?<><Text style={styles.text}>Los destinos se revelan al aceptar.</Text><Button label="ACEPTAR MISIÓN" disabled={busy} onPress={()=>void respond(true)}/><Button label="RECHAZAR" danger disabled={busy} onPress={()=>void respond(false)}/></>:<Text style={styles.signal}>{recipient?.state.toUpperCase()} · ETAPA {recipient?.unlocked_step}</Text>}
    {mapsConfigured && mapPoints.length>0 && <MapView provider={PROVIDER_GOOGLE} style={styles.map} customMapStyle={nightMap} showsUserLocation={locationAllowed} region={{latitude:mapPoints[mapPoints.length-1].latitude,longitude:mapPoints[mapPoints.length-1].longitude,latitudeDelta:0.035,longitudeDelta:0.035}}>{mapPoints.map(p=><Marker key={p.id} coordinate={{latitude:p.latitude,longitude:p.longitude}} title={p.label} pinColor="#00e5ff"/>)}</MapView>}
    {mapPoints.length>0 && <Button label="Mostrar mi ubicación" onPress={()=>void perform(async()=>{const permission=await Location.requestForegroundPermissionsAsync();if(permission.status!=='granted')throw new Error('Permiso de ubicación denegado.');setLocationAllowed(true);})}/>}
    {points.map(p=><View key={p.id} style={styles.point}><Text style={styles.text}>{p.position}. {p.label}</Text><Button label="NAVEGAR CON GOOGLE MAPS" disabled={busy||p.latitude===null||p.longitude===null} onPress={()=>void navigate(p)}/></View>)}
    {recipient?.state==='accepted' && <Text style={styles.text}>El centro de control confirma cada etapa y habilita el siguiente destino.</Text>}
   </View>}
  </>}
 </ScrollView></View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#060b11'},container:{padding:22,paddingTop:65,paddingBottom:40,gap:16},center:{flex:1,backgroundColor:'#060b11',alignItems:'center',justifyContent:'center'},signal:{color:'#00e5ff',fontSize:12,letterSpacing:2,fontWeight:'700'},title:{color:'#f4fbff',fontSize:29,fontWeight:'900',letterSpacing:1},subtitle:{color:'#f4fbff',fontSize:22,fontWeight:'700'},text:{color:'#a5b8c8',fontSize:15,lineHeight:23},card:{backgroundColor:'#0e1823',padding:18,borderWidth:1,borderColor:'#1a3949',borderRadius:14,gap:15},input:{backgroundColor:'#060b11',borderColor:'#284253',borderWidth:1,borderRadius:8,color:'white',padding:14},button:{padding:14,backgroundColor:'#00d9ed',borderRadius:8,alignItems:'center'},danger:{backgroundColor:'#ff555f'},buttonText:{color:'#031319',fontWeight:'800',fontSize:12},error:{color:'#ff7a83',backgroundColor:'#29131a',padding:14,borderRadius:8},toolbar:{flexDirection:'row',gap:12},map:{height:300,borderRadius:12},point:{borderTopWidth:1,borderTopColor:'#284253',paddingTop:15,gap:10}});
