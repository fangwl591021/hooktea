import worker from './worker.js';
import {trackCrmRequest,TRACKING_RELEASE} from './crm-write-tracker.js';

export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/api/health')return Response.json({
      ok:true,service:'hooktea',release:'20260916-registration-first-v3',trackingRelease:TRACKING_RELEASE,
      registrationRelease:'20260916-child-registration-v1',
    },{headers:{'Cache-Control':'no-store'}});
    if(request.method==='OPTIONS')return worker.fetch(request,env,ctx);
    // GET callbacks may mutate orders too. Do not exempt them as read-only.
    return trackCrmRequest({db:env.DB,ctx,run:admitted=>worker.fetch(request,env,admitted)});
  },
};
