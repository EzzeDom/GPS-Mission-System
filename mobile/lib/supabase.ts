import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import { chunkedSecureStorage } from './secure-session';
import { createClient, processLock } from '@supabase/supabase-js';
export const configured=Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
export const supabase=createClient(process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://not-configured.supabase.co',process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'not-configured',{
 auth:{storage:chunkedSecureStorage({getItem:SecureStore.getItemAsync,setItem:SecureStore.setItemAsync,removeItem:SecureStore.deleteItemAsync}),persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,lock:processLock}
});
