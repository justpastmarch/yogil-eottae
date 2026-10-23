export async function routeRendererRequest(route, appOrigin, accessToken) {
  const request=route.request();
  const headers={...request.headers()};
  delete headers['oai-sites-authorization'];
  if(new URL(request.url()).origin===appOrigin&&accessToken){
    headers['oai-sites-authorization']=`Bearer ${accessToken}`;
    const response=await route.fetch({headers,maxRedirects:0});
    const location=response.headers().location;
    if(location&&new URL(location,request.url()).origin!==appOrigin){
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill({response});
    return;
  }
  await route.continue({headers});
}
