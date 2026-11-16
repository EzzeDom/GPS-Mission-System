type Store={getItem:(key:string)=>Promise<string|null>;setItem:(key:string,value:string)=>Promise<void>;removeItem:(key:string)=>Promise<void>};
type Manifest={generation:string;count:number};
// SecureStore payloads are split to stay below historical iOS value-size limits.
// Publish the manifest only after every encrypted chunk is written.
export function chunkedSecureStorage(store:Store):Store {
 const manifest=async(key:string):Promise<Manifest|null>=>{const raw=await store.getItem(key+'.manifest');if(!raw)return null;const m=JSON.parse(raw) as Manifest;if(!Number.isInteger(m.count)||m.count<1||m.count>1024||!/^[a-z0-9-]+$/.test(m.generation))throw new Error('Invalid session manifest');return m;};
 const chunkKey=(key:string,m:Manifest,i:number)=>`${key}.${m.generation}.${i}`;
 return {
  async getItem(key){const m=await manifest(key);if(!m)return null;const parts=await Promise.all(Array.from({length:m.count},(_,i)=>store.getItem(chunkKey(key,m,i))));if(parts.some(p=>p===null))throw new Error('Incomplete secure session');return parts.join('');},
  async setItem(key,value){const old=await manifest(key);const m={generation:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),count:Math.max(1,Math.ceil(value.length/256))};if(m.count>1024)throw new Error('Session exceeds storage limit');for(let i=0;i<m.count;i++)await store.setItem(chunkKey(key,m,i),value.slice(i*256,(i+1)*256));await store.setItem(key+'.manifest',JSON.stringify(m));if(old)await Promise.all(Array.from({length:old.count},(_,i)=>store.removeItem(chunkKey(key,old,i))));},
  async removeItem(key){const m=await manifest(key);await store.removeItem(key+'.manifest');if(m)await Promise.all(Array.from({length:m.count},(_,i)=>store.removeItem(chunkKey(key,m,i))));}
 };
}
