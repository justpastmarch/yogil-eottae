import type {Place} from '../lib/domain.ts';

type Props={place:Place};

export default function DestinationInfo({place}:Props){
 const phone=place.phone?.replace(/[^+0-9]/g,'');
 return <details className="destination-info" aria-label={`${place.name} 방문 정보`}>
  <summary>리뷰 기반 출입구·실내 정보 <span>미제공</span></summary>
  <p>분석할 리뷰 사진이 없어 출입구 단차, 실내 이동과 엘리베이터를 확인하지 못했어요. 통행이 막혔다는 뜻은 아닙니다. 시설에 문의하거나 장소 상세에서 확인해 주세요.</p>
  <div className="destination-info-actions">
   {phone&&<a href={`tel:${phone}`}>시설에 전화하기 <span>{place.phone}</span></a>}
   {place.placeUrl&&<a href={place.placeUrl} target="_blank" rel="noopener noreferrer">카카오맵에서 장소 상세 보기 <span>새 창</span></a>}
  </div>
  {!phone&&!place.placeUrl&&<p>이 장소의 연락처와 상세 페이지 정보는 제공되지 않았어요.</p>}
 </details>;
}
