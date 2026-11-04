import {readFileSync,writeFileSync} from 'node:fs';
import {NtExecutable,NtExecutableResource} from 'pe-library';
import {Data,Resource} from 'resedit';

export function setWindowsIcon(executable,icon){
  const pe=NtExecutable.from(readFileSync(executable),{ignoreCert:true});
  const resources=NtExecutableResource.from(pe);
  const icons=Data.IconFile.from(readFileSync(icon)).icons.map(item=>item.data);
  const groups=Resource.IconGroupEntry.fromEntries(resources.entries);
  for(const group of groups.length?groups:[{id:1,lang:1033}])Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group.id,group.lang,icons);
  resources.outputResource(pe);
  writeFileSync(executable,Buffer.from(pe.generate()));
}
