import type {Place} from './domain.ts';

// Operator pages are general status listings, not verified results for the selected station.
export function stationFacilityInfo(place:Place):{stationName:string;operator?:string;url?:string}|null{
 if(!/역(?:\s|$|\()/u.test(place.name))return null;
 if(/^서울(?:특별시)?\s/u.test(place.address))return {stationName:place.name,operator:'서울교통공사',url:'https://seoulmetro.co.kr/kr/equipmentList.do?menuIdx=367'};
 if(/^부산(?:광역시)?\s/u.test(place.address))return {stationName:place.name,operator:'부산교통공사',url:'https://www.humetro.busan.kr/homepage/default/subwayElevator/list.do?menu_no=1001010710'};
 return {stationName:place.name};
}
