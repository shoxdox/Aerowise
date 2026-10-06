const fs=require('fs');
const receipts=[];
for(const org of fs.readdirSync('/data/files')) {
 const dir='/data/files/'+org+'/outbox'; if(!fs.existsSync(dir)) continue;
 for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))) {
  const receipt=JSON.parse(fs.readFileSync(dir+'/'+name));
  const eml=fs.readFileSync(dir+'/'+name.replace(/\.json$/,'.eml'),'utf8');
  const subject=eml.match(/^Subject: (.*)$/m)?.[1];
  if(/invit|password|demo request/i.test(subject||'')) receipts.push({organization:org,subject,transport:receipt.response.transport,to:receipt.response.to,at:receipt.acceptedAt});
 }
}
console.log(JSON.stringify(receipts,null,2));
