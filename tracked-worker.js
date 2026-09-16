import worker from './worker.js';
import {trackCrmRequest,TRACKING_RELEASE} from './crm-write-tracker.js';
import {NEW_MEMBER_POINTS_RELEASE} from './new-member-points.js';
import {ALERT_RELEASE,alertRoute,createIssueReporter,inspectAlertResponse,drainAlerts} from './operational-alerts.js';

export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/api/health')return Response.json({
      ok:true,service:'hooktea',release:NEW_MEMBER_POINTS_RELEASE,trackingRelease:TRACKING_RELEASE,
      registrationRelease:'20260916-child-registration-v1',
      newMemberPointsAuthority:String(env.HOOKTEA_NEW_MEMBER_CHILD_POINTS)==='true'?'child':'disabled',
      legacyPointsAuthority:'unchanged',
      reviewedEmptyAccountRelease:'20260916-reviewed-empty-v1',
      reviewedLegacyBindingRelease:'20260916-reviewed-legacy-v1',
      alertRelease:ALERT_RELEASE,telegramAlertsEnabled:String(env.HOOKTEA_TELEGRAM_ALERTS)==='true',
    },{headers:{'Cache-Control':'no-store'}});
    if(request.method==='OPTIONS')return worker.fetch(request,env,ctx);
    // GET callbacks may mutate orders too. Do not exempt them as read-only.
    const traceId=crypto.randomUUID();
    const report=createIssueReporter(env,ctx,alertRoute(request),traceId);
    const scopedEnv={...env,HOOKTEA_REPORT_ISSUE:report};
    try {
      const response=await trackCrmRequest({db:env.DB,ctx,id:traceId,onIssue:report,
        run:admitted=>worker.fetch(request,scopedEnv,admitted)});
      if(String(env.HOOKTEA_TELEGRAM_ALERTS)==='true')ctx.waitUntil(inspectAlertResponse(response.clone(),report).catch(()=>{}));
      const headers=new Headers(response.headers);headers.set('X-HookTea-Trace-Id',traceId);
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch(error) {report({category:'request',code:'internal_error'});throw error;}
  },
  async scheduled(event,env,ctx) {ctx.waitUntil(drainAlerts(env));},
};
