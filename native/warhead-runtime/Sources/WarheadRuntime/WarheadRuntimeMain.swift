import Foundation
import MLXLLM
import MLXLMCommon
import MLXHuggingFace
import HuggingFace
import Tokenizers

/// Minimal shape used to recover the request id even when the rest of the
/// payload cannot be decoded. Without it, a decoding failure emits an id-0
/// error and the caller's request would wait forever.
private struct Envelope: Decodable {
    let id: Int
}

private struct Request: Decodable {
    let id: Int
    let method: String
    let model: String?
    let messages: [[String: AnyCodable]]?
    let tools: [[String: AnyCodable]]?
    let numPredict: Int?
}

/// JSON-compatible, Sendable wrapper used at the process boundary.
struct AnyCodable: Decodable, @unchecked Sendable {
    let value: Any
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = NSNull() }
        else if let v = try? container.decode(Bool.self) { value = v }
        else if let v = try? container.decode(Int.self) { value = v }
        else if let v = try? container.decode(Double.self) { value = v }
        else if let v = try? container.decode(String.self) { value = v }
        else if let v = try? container.decode([String: AnyCodable].self) { value = v.mapValues(\.value) }
        else if let v = try? container.decode([AnyCodable].self) { value = v.map(\.value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON value") }
    }
}

private var modelContainer: ModelContainer?
private var llamaEngine: LlamaEngine?
private var loadedModelID: String?

private func sendable(_ value: Any) -> (any Sendable)? {
    if value is NSNull { return NSNull() }
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value }
    if let values = value as? [Any] {
        let converted = values.compactMap(sendable)
        return converted.count == values.count ? converted : nil
    }
    if let values = value as? [String: Any] {
        var converted: [String: any Sendable] = [:]
        for (key, value) in values {
            guard let item = sendable(value) else { return nil }
            converted[key] = item
        }
        return converted
    }
    return nil
}

func emit(_ id: Int, _ event: String, _ fields: [String: Any] = [:]) {
    var value: [String: Any] = ["id": id, "event": event]
    fields.forEach { value[$0.key] = $0.value }
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

private func chatMessage(_ wire: [String: Any]) -> Chat.Message? {
    guard let role = wire["role"] as? String,
          let content = wire["content"] as? String else { return nil }
    switch role {
    case "system": return .system(content)
    case "user": return .user(content)
    case "tool":
        return .tool(content, id: wire["tool_call_id"] as? String,
                     name: wire["tool_name"] as? String)
    case "assistant":
        let calls = (wire["tool_calls"] as? [[String: Any]])?.compactMap { call -> MLXLMCommon.ToolCall? in
            guard let function = call["function"] as? [String: Any],
                  let name = function["name"] as? String,
                  let rawArgs = function["arguments"],
                  let args = rawArgs as? [String: Any] else { return nil }
            var converted: [String: any Sendable] = [:]
            for (key, value) in args {
                guard let item = sendable(value) else { return nil }
                converted[key] = item
            }
            return MLXLMCommon.ToolCall(
                function: .init(name: name, arguments: converted),
                id: call["id"] as? String
            )
        }
        return .assistant(content, toolCalls: calls?.isEmpty == false ? calls : nil)
    default: return nil
    }
}

private func load(_ id: Int, model: String) async throws {
    if model.hasPrefix("gguf:") {
        let path = String(model.dropFirst(5))
        guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else {
            throw RuntimeError.invalidRequest("GGUF model path is not a readable local file")
        }
        llamaEngine = try LlamaEngine(path: path)
        modelContainer = nil
        loadedModelID = model
        emit(id, "loaded", ["model": model, "engine": "llama.cpp"])
        emit(id, "done")
        return
    }
    guard model.hasPrefix("mlx:") else {
        throw RuntimeError.unsupportedModel("Use mlx:<Hugging Face model ID or local directory>, gguf:<path>, or ollama:<local tag>.")
    }
    let reference = String(model.dropFirst(4))
    guard !reference.isEmpty else { throw RuntimeError.invalidRequest("MLX model reference is empty") }
    let container: ModelContainer
    if reference.hasPrefix("/") {
        container = try await loadModelContainer(
            from: URL(filePath: reference),
            using: #huggingFaceTokenizerLoader()
        )
    } else {
        container = try await loadModelContainer(
            from: #hubDownloader(),
            using: #huggingFaceTokenizerLoader(),
            id: reference
        )
    }
    modelContainer = container
    llamaEngine = nil
    loadedModelID = model
    emit(id, "loaded", ["model": model, "engine": "mlx"])
    emit(id, "done")
}

private func chat(_ request: Request) async throws {
    guard let loadedModelID else {
        throw RuntimeError.notLoaded
    }
    if let requested = request.model, requested != loadedModelID {
        throw RuntimeError.invalidRequest("requested model differs from the loaded runtime model")
    }
    if let llamaEngine {
        let messages = (request.messages ?? []).compactMap { wire -> LlamaMessage? in
            guard let role = wire["role"]?.value as? String else { return nil }
            let body = wire["content"]?.value as? String ?? ""
            if role == "assistant", let calls = wire["tool_calls"]?.value as? [[String: Any]] {
                let callText = calls.map { call -> String in
                    let fn = call["function"] as? [String: Any] ?? [:]
                    let name = fn["name"] as? String ?? "unknown"
                    let args = fn["arguments"] ?? [:]
                    let json = (try? JSONSerialization.data(withJSONObject: args)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
                    return "<tool_call>{\"name\":\"\(name)\",\"arguments\":\(json)}</tool_call>"
                }.joined(separator: "\n")
                return LlamaMessage(role: role, content: body + "\n" + callText)
            }
            return LlamaMessage(role: role, content: body)
        }
        guard !messages.isEmpty else { throw RuntimeError.invalidRequest("chat requires messages") }
        try llamaEngine.generate(messages: messages, tools: request.tools ?? [], requestID: request.id, maxTokens: request.numPredict ?? 1024)
        return
    }
    guard let modelContainer else { throw RuntimeError.notLoaded }
    let messages = (request.messages ?? []).compactMap { chatMessage($0.mapValues(\.value)) }
    guard !messages.isEmpty else { throw RuntimeError.invalidRequest("chat requires messages") }
    let toolSpecs: [ToolSpec] = (request.tools ?? []).compactMap { wrapped in
        var values: [String: any Sendable] = [:]
        for (key, item) in wrapped {
            guard let converted = sendable(item.value) else { return nil }
            values[key] = converted
        }
        return values
    }
    let input = UserInput(chat: messages, tools: toolSpecs.isEmpty ? nil : toolSpecs)
    let lmInput = try await modelContainer.prepare(input: input)
    let parameters = GenerateParameters(maxTokens: request.numPredict ?? 1024)
    let stream = try await modelContainer.generate(
        input: lmInput,
        parameters: parameters,
        tools: toolSpecs.isEmpty ? nil : toolSpecs
    )
    for await item in stream {
        switch item {
        case .chunk(let text): emit(request.id, "text", ["delta": text])
        case .toolCall(let call):
            let encoded = try JSONEncoder().encode(call.function.arguments)
            let args = (try JSONSerialization.jsonObject(with: encoded)) as? [String: Any] ?? [:]
            emit(request.id, "tool_call", [
                "call": ["id": call.id ?? UUID().uuidString,
                         "name": call.function.name,
                         "args": args],
            ])
        case .info(let info):
            emit(request.id, "done", ["evalCount": info.generationTokenCount,
                                       "promptEvalCount": info.promptTokenCount])
        case .rejectedToolCall(let rejected):
            throw RuntimeError.invalidRequest(
                "the model produced an invalid tool call (\(rejected.reason.rawValue))"
            )
        }
    }
}

private enum RuntimeError: Error, LocalizedError {
    case invalidRequest(String)
    case unsupportedModel(String)
    case notLoaded
    var errorDescription: String? {
        switch self {
        case .invalidRequest(let message): return message
        case .unsupportedModel(let message): return message
        case .notLoaded: return "no model is loaded"
        }
    }
}

@main
private struct WarheadRuntime {
    static func main() async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8) else { continue }
            do {
                let request = try JSONDecoder().decode(Request.self, from: data)
                switch request.method {
                case "load":
                    guard let model = request.model else { throw RuntimeError.invalidRequest("load requires model") }
                    try await load(request.id, model: model)
                case "chat":
                    try await chat(request)
                case "shutdown":
                    return
                default:
                    throw RuntimeError.invalidRequest("unknown method: \(request.method)")
                }
            } catch {
                let id = (try? JSONDecoder().decode(Envelope.self, from: data))?.id ?? 0
                emit(id, "error", ["message": error.localizedDescription])
            }
        }
    }
}
