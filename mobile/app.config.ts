import type { ExpoConfig } from 'expo/config';
const config: ExpoConfig={
 name:'GPS Mission System',slug:'gps-mission-system',version:'0.2.0',scheme:'gpsmission',orientation:'portrait',userInterfaceStyle:'dark',
 ios:{bundleIdentifier:'com.ezzedom.gpsmission',supportsTablet:false},
 android:{package:'com.ezzedom.gpsmission',...(process.env.GOOGLE_SERVICES_JSON ? {googleServicesFile:process.env.GOOGLE_SERVICES_JSON}:{})},
 plugins:['expo-router','expo-secure-store','expo-dev-client',['expo-notifications',{color:'#00e5ff'}],['expo-location',{locationWhenInUsePermission:'Mostrar tu posición durante una misión.'}],['react-native-maps',{androidGoogleMapsApiKey:process.env.GOOGLE_MAPS_ANDROID_KEY,iosGoogleMapsApiKey:process.env.GOOGLE_MAPS_IOS_KEY}]],
 extra:{eas:{projectId:process.env.EXPO_PUBLIC_EAS_PROJECT_ID},mapsConfigured:{android:Boolean(process.env.GOOGLE_MAPS_ANDROID_KEY),ios:Boolean(process.env.GOOGLE_MAPS_IOS_KEY)}}
};
export default config;
