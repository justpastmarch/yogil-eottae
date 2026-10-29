import type {Place} from '../lib/domain.ts';
import {stationFacilityInfo} from '../lib/station.ts';

export default function StationFacilityInfo({place}:{place:Place}){
 const link=stationFacilityInfo(place);
 if(!link||!link.operator||!link.url)return null;
 return <details className="destination-info" aria-label={`${link.stationName} 공식 승강설비 안내`}>
  <summary>역 승강설비 공식 안내 <span>{link.operator}</span></summary>
  <p>{link.stationName}의 엘리베이터 운행 상태는 아래 공식 안내에서 직접 확인하세요. 이 앱은 현재 운행 여부를 확인하지 않았어요.</p>
  <p className="subnote">운영기관의 관할 역·설비와 갱신 시각을 확인하세요.</p>
  <div className="destination-info-actions"><a href={link.url} target="_blank" rel="noopener noreferrer">{link.operator} 승강설비 가동현황 <span>새 창</span></a></div>
 </details>;
}
