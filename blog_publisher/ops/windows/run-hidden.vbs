' 예약 작업용 무창(無窓) 런처.
'
' 배경: 작업들이 이미 powershell.exe -WindowStyle Hidden 으로 실행되지만,
' LogonType=Interactive 에서는 콘솔이 먼저 할당된 뒤 숨겨져 창이 깜빡인다.
' 1분 주기 작업까지 있어 화면에 계속 터미널이 떴다 사라진다.
' S4U 로 바꾸면 없앨 수 있으나 관리자 권한이 필요하고, S4U 는 네트워크 자격증명
' 접근이 제한돼 git fetch(맥 변경 수신)가 깨질 수 있다.
'
' WScript.Shell.Run(cmd, 0, False) 은 창을 아예 만들지 않으므로 깜빡임이 없고,
' 로그온 타입을 그대로 두어 git 인증에도 영향이 없다.
'
' 사용: wscript.exe //nologo run-hidden.vbs <powershell 에 넘길 인자들...>

Option Explicit
Dim sh, cmd, i, a
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass"
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then
    cmd = cmd & " """ & a & """"
  Else
    cmd = cmd & " " & a
  End If
Next
' 0 = 창 없음, True = 종료까지 대기.
' 대기하지 않으면 예약 작업이 즉시 "완료"로 끝나, Task Scheduler 의 중복 실행 방지
' (IgnoreNew)가 무력화되고 실행이 겹쳐 쌓인다(2코어 PC에서 특히 위험).
' 대기하면 실제 소요시간과 종료코드가 스케줄러에 그대로 보고된다.
Dim rc
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
