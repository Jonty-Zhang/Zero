#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <sddl.h>

#include <cwchar>
#include <string>
#include <vector>

namespace {
constexpr DWORD kFailure = 70;
constexpr DWORD kInvalidArgs = 64;
constexpr DWORD kNotJobMember = 65;
constexpr DWORD kVerifyFailure = 66;
constexpr DWORD kPollMilliseconds = 25;

bool IsSafeLockId(const wchar_t* value) {
  if (value == nullptr || *value == L'\0') return false;
  size_t length = 0;
  for (const wchar_t* p = value; *p != L'\0'; ++p) {
    if (++length > 64) return false;
    const wchar_t c = *p;
    if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
          (c >= L'0' && c <= L'9') || c == L'_' || c == L'-')) {
      return false;
    }
  }
  return true;
}

bool ParseProcessId(const wchar_t* value, DWORD* process_id) {
  if (value == nullptr || *value == L'\0') return false;
  DWORD parsed = 0;
  for (const wchar_t* p = value; *p != L'\0'; ++p) {
    if (*p < L'0' || *p > L'9') return false;
    const DWORD digit = static_cast<DWORD>(*p - L'0');
    if (parsed > (MAXDWORD - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  if (parsed == 0) return false;
  *process_id = parsed;
  return true;
}

std::wstring QuoteArgument(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return argument;
  }

  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t c : argument) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }
    if (c == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(c);
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(c);
    }
    backslashes = 0;
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

std::wstring BuildCommandLine(int argc, wchar_t** argv, int child_start) {
  std::wstring result;
  for (int i = child_start; i < argc; ++i) {
    if (!result.empty()) result.push_back(L' ');
    result += QuoteArgument(argv[i]);
  }
  return result;
}

std::wstring CurrentUserSidString() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return {};

  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  if (bytes == 0) {
    CloseHandle(token);
    return {};
  }
  std::vector<unsigned char> buffer(bytes);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), bytes, &bytes)) {
    CloseHandle(token);
    return {};
  }
  CloseHandle(token);

  auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) return {};
  std::wstring result(sid);
  LocalFree(sid);
  return result;
}

bool CreateGenerationId(std::wstring* result) {
  HCRYPTPROV provider = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_FULL,
                            CRYPT_VERIFYCONTEXT | CRYPT_SILENT)) return false;
  unsigned char bytes[16]{};
  const BOOL generated = CryptGenRandom(provider, sizeof(bytes), bytes);
  CryptReleaseContext(provider, 0);
  if (!generated) return false;
  constexpr wchar_t hex[] = L"0123456789abcdef";
  result->clear();
  result->reserve(32);
  for (unsigned char byte : bytes) {
    result->push_back(hex[byte >> 4]);
    result->push_back(hex[byte & 0x0f]);
  }
  return true;
}

DWORD WaitForJobToBecomeEmpty(HANDLE job) {
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                   &accounting, sizeof(accounting), nullptr)) {
      return GetLastError();
    }
    if (accounting.ActiveProcesses == 0) return ERROR_SUCCESS;
    Sleep(kPollMilliseconds);
  }
}

DWORD WaitForPreviousJobToBecomeEmpty(const std::wstring& job_name) {
  HANDLE previous_job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, job_name.c_str());
  if (previous_job == nullptr) {
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : error;
  }

  const DWORD result = WaitForJobToBecomeEmpty(previous_job);
  CloseHandle(previous_job);
  return result;
}

int VerifyMember(int argc, wchar_t** argv) {
  DWORD process_id = 0;
  if (argc != 6 || wcscmp(argv[2], L"--lock-id") != 0 || !IsSafeLockId(argv[3]) ||
      wcscmp(argv[4], L"--pid") != 0 || !ParseProcessId(argv[5], &process_id)) {
    return static_cast<int>(kInvalidArgs);
  }

  const std::wstring sid = CurrentUserSidString();
  if (sid.empty()) return static_cast<int>(kVerifyFailure);
  const std::wstring job_name = L"Global\\ZeroGuardianJob_" + sid + L"_" + argv[3];
  HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, job_name.c_str());
  if (job == nullptr) return static_cast<int>(kVerifyFailure);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (process == nullptr) {
    CloseHandle(job);
    return static_cast<int>(kVerifyFailure);
  }
  BOOL is_member = FALSE;
  const BOOL queried = IsProcessInJob(process, job, &is_member);
  CloseHandle(process);
  CloseHandle(job);
  if (!queried) return static_cast<int>(kVerifyFailure);
  return is_member ? 0 : static_cast<int>(kNotJobMember);
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--verify-member") == 0) {
    return VerifyMember(argc, argv);
  }
  if (argc < 5 || wcscmp(argv[1], L"--lock-id") != 0 ||
      !IsSafeLockId(argv[2]) || wcscmp(argv[3], L"--") != 0 ||
      argv[4][0] == L'\0') {
    return static_cast<int>(kInvalidArgs);
  }

  const std::wstring sid = CurrentUserSidString();
  if (sid.empty()) return static_cast<int>(kFailure);

  // The default DACL restricts the object to the current user's token. Including
  // the SID in the name makes the lock per-user across interactive sessions.
  const std::wstring mutex_name = L"Global\\ZeroGuardian_" + sid + L"_" + argv[2];
  const std::wstring job_name = L"Global\\ZeroGuardianJob_" + sid + L"_" + argv[2];
  SECURITY_ATTRIBUTES non_inheritable{};
  non_inheritable.nLength = sizeof(non_inheritable);
  non_inheritable.bInheritHandle = FALSE;
  SetLastError(ERROR_SUCCESS);
  HANDLE mutex = CreateMutexW(&non_inheritable, TRUE, mutex_name.c_str());
  if (mutex == nullptr) return static_cast<int>(kFailure);
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    const DWORD wait = WaitForSingleObject(mutex, 0);
    if (wait == WAIT_TIMEOUT) {
      CloseHandle(mutex);
      return static_cast<int>(ERROR_ALREADY_EXISTS);
    }
    if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) {
      CloseHandle(mutex);
      return static_cast<int>(kFailure);
    }
  }

  // Do not open the previous Job until this process owns the mutex. Keeping an
  // old Job handle open before the old guardian exits suppresses last-handle
  // KILL_ON_JOB_CLOSE behavior.
  if (WaitForPreviousJobToBecomeEmpty(job_name) != ERROR_SUCCESS) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  // These child variables describe the successful mutex + prior-Job check above.
  // They are lineage assertions, not a secret or proof against the same account.
  std::wstring generation;
  if (!CreateGenerationId(&generation) ||
      !SetEnvironmentVariableW(L"ZERO_GUARDIAN_LOCK_ID", argv[2]) ||
      !SetEnvironmentVariableW(L"ZERO_GUARDIAN_GENERATION", generation.c_str()) ||
      !SetEnvironmentVariableW(L"ZERO_GUARDIAN_PREDECESSOR_DRAINED", L"1")) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  SetLastError(ERROR_SUCCESS);
  HANDLE job = CreateJobObjectW(&non_inheritable, job_name.c_str());
  if (job == nullptr) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  std::wstring command_line = BuildCommandLine(argc, argv, 4);
  if (command_line.size() >= 32767) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kInvalidArgs);
  }
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(argv[4], mutable_command.data(), nullptr, nullptr, FALSE,
                      CREATE_SUSPENDED, nullptr, nullptr, &startup, &process)) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, kFailure);
    WaitForSingleObject(process.hProcess, INFINITE);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    TerminateJobObject(job, kFailure);
    WaitForSingleObject(process.hProcess, INFINITE);
    WaitForJobToBecomeEmpty(job);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD child_exit_code = kFailure;
  GetExitCodeProcess(process.hProcess, &child_exit_code);

  // The direct launcher can exit while descendants still run. Kill all remaining
  // members, then retain both handles until the Job reports no active processes.
  TerminateJobObject(job, child_exit_code);
  WaitForJobToBecomeEmpty(job);

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(job);
  ReleaseMutex(mutex);
  CloseHandle(mutex);
  return static_cast<int>(child_exit_code);
}
