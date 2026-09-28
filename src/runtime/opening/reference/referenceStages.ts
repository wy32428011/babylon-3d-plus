export type ReferenceOpeningStage = {start:number;end:number;label:string;title:string;en:string;detail:string;ref:number;place:string};
export const REFERENCE_DURATION_SECONDS = 62;
export const REFERENCE_STAGES:readonly ReferenceOpeningStage[]=[
  {start:0,end:9,label:'旋转地球',title:'连接世界，始于中国',en:'ONE PLANET. INFINITE CONNECTIONS.',detail:'地球旋转 · 中国轮廓锁定',ref:1,place:'地球'},
  {start:9,end:16,label:'地球展开',title:'让全球视野，徐徐展开',en:'A WORLD OF POSSIBILITIES.',detail:'球面展开 · 全球版图',ref:2,place:'全球'},
  {start:16,end:24,label:'全球业务',title:'从中国，连接世界',en:'CHINA TO THE WORLD.',detail:'跨境飞行线 · 动态业务网络',ref:3,place:'全球'},
  {start:24,end:30,label:'中国全景',title:'聚焦中国',en:'A CLOSER LOOK AT CHINA.',detail:'镜头推进 · 全国行政区划',ref:4,place:'中国'},
  {start:30,end:34,label:'江苏高亮',title:'聚焦江苏',en:'FOCUS ON JIANGSU.',detail:'区域高亮 · 锁定江苏',ref:5,place:'中国 / 江苏'},
  {start:34,end:42,label:'国内业务',title:'以江苏，连接全国',en:'JIANGSU. CONNECTED NATIONWIDE.',detail:'城市飞行线 · 国内业务网络',ref:6,place:'中国 / 江苏'},
  {start:42,end:48,label:'江苏全景',title:'江苏 · 无锡',en:'JIANGSU / WUXI.',detail:'省域推进 · 高亮无锡',ref:7,place:'中国 / 江苏 / 无锡'},
  {start:48,end:54,label:'无锡全景',title:'无锡 · 惠山',en:'WUXI / HUISHAN.',detail:'市域推进 · 高亮惠山区',ref:8,place:'中国 / 江苏 / 无锡 / 惠山'},
  {start:54,end:62,label:'抵达惠山',title:'抵达惠山\n走进智能仓储',en:'THE FUTURE OF INTELLIGENT WAREHOUSING.',detail:'惠山区 · 中鼎智能（无锡）科技股份有限公司',ref:9,place:'中国 / 江苏 / 无锡 / 惠山'}
];
