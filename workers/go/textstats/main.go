// textstats —— Morrow 首个 Go Worker 示范（票 M2-T2 / Issue #23，PRD §2 双语言 TS/Go）。
//
// 职责：文本规范化与行/词/字节数统计（最小、确定、零依赖，专职示范注册与调用链路）。
// 协议：与沙箱内 TS 工具完全一致（apps/runtime/src/sandbox/protocol.ts）——
//   stdin:  {"mode":"count"|"normalize","text":"..."}（单行 JSON）
//   stdout: {"ok":true,"result":{...}} 或 {"ok":false,"error":"..."}（单行信封，最后一个非空行）
// 注册形态：manifest {author:"human", runtime:"go", sandbox:{type:"builtin"}}——human vetted
// 编译产物直跑（不经容器）；调用经 ToolInvoker 同一接缝，执行前过 PermissionEngine 复核。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

type ToolInput struct {
	Mode string `json:"mode"`
	Text string `json:"text"`
}

type Envelope struct {
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

func emit(ok bool, result interface{}, errMsg string) {
	out, err := json.Marshal(Envelope{OK: ok, Result: result, Error: errMsg})
	if err != nil {
		out = []byte(`{"ok":false,"error":"envelope marshal failed"}`)
	}
	fmt.Println(string(out))
}

// count 统计行数（按 \n 切分语义）、词数（空白切分）、字节数（UTF-8 原始字节）
func count(text string) map[string]int {
	scanner := bufio.NewScanner(strings.NewReader(text))
	scanner.Split(bufio.ScanLines)
	lines := 0
	for scanner.Scan() {
		lines++
	}
	return map[string]int{
		"lines": lines,
		"words": len(strings.Fields(text)),
		"bytes": len(text),
	}
}

// normalize 规范化：折叠连续空白为单空格、去首尾、转小写
func normalize(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(text), " "))
}

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		emit(false, nil, "read stdin failed: "+err.Error())
		os.Exit(1)
	}
	var input ToolInput
	if err := json.Unmarshal(data, &input); err != nil {
		emit(false, nil, "malformed stdin JSON: "+err.Error())
		os.Exit(1)
	}
	switch input.Mode {
	case "count":
		emit(true, count(input.Text), "")
	case "normalize":
		emit(true, map[string]string{"text": normalize(input.Text)}, "")
	default:
		emit(false, nil, fmt.Sprintf("unknown mode: %q (want count|normalize)", input.Mode))
		os.Exit(1)
	}
}
