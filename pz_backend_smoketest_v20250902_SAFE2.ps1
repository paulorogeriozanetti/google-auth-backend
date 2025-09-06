# PZ Backend Smoketest – v2025-09-02-SAFE2
$BASE        = 'https://api.pzadvisors.com'
$TRACK_TOKEN = '45015ad973d24607b966469e4d5f72a3'
$DEBUG_TOKEN = '4bb13d5922104fd1aa16d824628284db'
$ORIGIN_OK   = 'https://pzadvisors.com'
$FAKE_TOKEN  = 'FAKE_TOKEN'
$PSDefaultParameterValues['ConvertTo-Json:Depth'] = 10

function WriteStep($t){ Write-Host "`n==== $t ====" -ForegroundColor Cyan }
function ShowJson($o){ if($null -eq $o){'(null)'} elseif($o -is [string]){ $o } else { $o | ConvertTo-Json } }
function TryIRM($uri,$method='GET',$headers=@{},$body=$null){
  try{ if($body -ne $null -and -not ($body -is [string])){$body=($body|ConvertTo-Json)}
       $r=Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -Body $body
       @{ok=$true;res=$r} }
  catch{ $st=$null; try{$st=$_.Exception.Response.StatusCode.value__}catch{}
         @{ok=$false;status=$st;err=$_.Exception.Message} }
}
function TryIWR($uri,$method='GET',$headers=@{},$body=$null){
  try{ if($body -ne $null -and -not ($body -is [string])){$body=($body|ConvertTo-Json)}
       $r=Invoke-WebRequest -Uri $uri -Method $method -Headers $headers -Body $body
       @{ok=$true;code=$r.StatusCode;headers=$r.Headers} }
  catch{ $st=$null;$hd=$null; try{$st=$_.Exception.Response.StatusCode.value__}catch{}; try{$hd=$_.Exception.Response.Headers}catch{}
         @{ok=$false;code=$st;headers=$hd;err=$_.Exception.Message} }
}

$summary=[ordered]@{}
Write-Host 'PZ Backend Smoketest' -ForegroundColor Yellow
Write-Host ('BASE: {0}' -f $BASE) -ForegroundColor DarkGray

WriteStep '1 - HEALTH /healthz'
$t1=TryIRM "$BASE/healthz"; ShowJson $t1.res; $summary.health=($t1.ok -and $t1.res.ok -eq $true)

WriteStep '2 - VERSION /api/version'
$t2=TryIRM "$BASE/api/version"; ShowJson $t2.res; $summary.version=($t2.ok -and $t2.res.version)

WriteStep '3 - CORS CHECK /api/cors-check'
$t3=TryIRM "$BASE/api/cors-check" 'GET' @{ 'Origin'=$ORIGIN_OK }; ShowJson $t3.res; $summary.cors=($t3.ok -and $t3.res.allowed -eq $true)

WriteStep '4 - PREFLIGHT OPTIONS /auth/google'
$t4=TryIWR "$BASE/auth/google" 'OPTIONS' @{ 'Origin'=$ORIGIN_OK; 'Access-Control-Request-Method'='POST' }
ShowJson @{ status=$t4.code; allow=$t4.headers.'Access-Control-Allow-Origin' }; $summary.preflight=($t4.code -eq 204)

WriteStep '5 - TRACK OPEN /api/track (sem token)'
$bodyOpen=@{ event='debug_test_open'; payload=@{ ts=[DateTimeOffset]::Now.ToUnixTimeSeconds() } }
$t5=TryIRM "$BASE/api/track" 'POST' @{ 'Content-Type'='application/json' } $bodyOpen
if($t5.ok){ ShowJson $t5.res; $summary.track_open_pass=$true } else { ShowJson @{ ok=$false; status=$t5.status; note='Se 403, endpoint protegido (OK quando TRACK_OPEN=false)' }; $summary.track_open_pass=($t5.status -eq 403) }

WriteStep '6 - TRACK PROTECTED /api/track (com X-Api-Token)'
$bodyProt=@{ event='debug_secured'; payload=@{ ok=$true; ts=[DateTimeOffset]::Now.ToUnixTimeSeconds() } }
$t6=TryIRM "$BASE/api/track" 'POST' @{ 'Content-Type'='application/json'; 'X-Api-Token'=$TRACK_TOKEN } $bodyProt
ShowJson $t6.res; $summary.track_protected=$t6.ok

WriteStep '7 - DEBUG FS-WRITE /api/debug/fs-write'
$t7=TryIRM "$BASE/api/debug/fs-write" 'POST' @{ 'X-Debug-Token'=$DEBUG_TOKEN; 'Content-Type'='application/json' } (@{ note='probe_ps1' })
ShowJson $t7.res; $summary.fs_write=($t7.ok -and $t7.res.ok -eq $true)

WriteStep '8 - DEBUG FS-TOKEN /api/debug/fs-token'
$t8=TryIRM "$BASE/api/debug/fs-token" 'GET' @{ 'X-Debug-Token'=$DEBUG_TOKEN }
ShowJson $t8.res; $summary.fs_token=($t8.ok -and $t8.res.ok -eq $true)

WriteStep '9 - DEBUG ENV-HAS-SA /api/debug/env-has-sa'
$t9=TryIRM "$BASE/api/debug/env-has-sa"; ShowJson $t9.res; $summary.env_sa=($t9.ok -and $t9.res.hasProj -and $t9.res.hasEmail -and $t9.res.hasKey)

WriteStep '10 - AUTH FAKE /auth/google (espera 401)'
$t10=TryIRM "$BASE/auth/google" 'POST' @{ 'Origin'=$ORIGIN_OK; 'Content-Type'='application/json' } (@{ credential=$FAKE_TOKEN })
if($t10.ok){ ShowJson $t10.res; $summary.auth_fake_expected_401=$false } else { ShowJson @{ ok=$false; status=$t10.status; note='401 esperado com token fake' }; $summary.auth_fake_expected_401=($t10.status -eq 401) }

Write-Host "`n==== SUMMARY ====" -ForegroundColor Yellow
$mustPass=@('health','version','cors','preflight','track_protected','fs_write','fs_token','env_sa','auth_fake_expected_401')
foreach($k in $summary.Keys){
  $val=[bool]$summary[$k]
  $color='Red'; if($val){ $color='Green' }
  Write-Host ("{0,-26} : {1}" -f $k, $val) -ForegroundColor $color
}
$failCount=($mustPass | Where-Object{ -not ([bool]$summary[$_]) }).Count
if($failCount -gt 0){ exit 1 } else { exit 0 }