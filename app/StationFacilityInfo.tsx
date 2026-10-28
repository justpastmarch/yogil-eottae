import type {Place} from '../lib/domain.ts';
import {stationFacilityInfo} from '../lib/station.ts';

export default function StationFacilityInfo({place}:{place:Place}){
 const link=stationFacilityInfo(place);
 if(!link)return null;
 return <details className="destination-info" aria-label={`${link.stationName} 승강설비 정보`}>
  <summary>역 승강설비 확인 <span>직접 조회</span></summary>
  <p>{link.stationName}의 엘리베이터 운행 여부는 이 앱에서 확인하지 못했어요. 미확인은 운행 중단을 뜻하지 않습니다.</p>
  {link.operator&&link.url?<><p>{link.operator} 승강설비 가동현황에서 이용할 역과 설비를 직접 확인하세요. 이 기관의 관할 역만 제공하며, 선택한 장소가 조회 대상인지와 정보 갱신 시각은 이 앱에서 확인하지 못했습니다.</p>
  <div className="destination-info-actions"><a href={link.url} target="_blank" rel="noopener noreferrer">{link.operator} 승강설비 가동현황 <span>새 창</span></a></div></>:<p>이 지역에 맞는 공식 승강설비 안내 링크가 등록되지 않았어요. 이용할 역의 운영기관에 문의하거나 해당 운영기관 홈페이지에서 확인하세요.</p>}
 </details>;
}
