> ⚠️ **API 规范文档职责边界**：本文档只定义前后端联调契约（端点路径、请求参数、响应 JSON、错误码）。
> 禁止出现：数据库表定义、SQL 类型、ORM 模型、业务背景描述、流程描述。
> 端点示例：「POST /api/v1/users — Body: {username: string (required, max 50), email: string (required)} → {id: number}」

# [项目名称] — 接口规范文档 (API Specification)

## 1. 接口清单

> **支撑原型页面所需的所有端点。**

| 序号 | 接口路径 | 方法 | 功能描述 | 对应页面操作 |
|------|---------|------|---------|-------------|
| 1 | `/api/v1/[resource]` | GET | 获取资源列表 | 列表页加载 / 筛选刷新 |
| 2 | `/api/v1/[resource]/{id}` | GET | 获取资源详情 | 点击列表行跳转详情 |
| 3 | `/api/v1/[resource]` | POST | 创建资源 | 新建按钮提交表单 |
| 4 | `/api/v1/[resource]/{id}` | PUT | 更新资源 | 编辑按钮提交表单 |
| 5 | `/api/v1/[resource]/{id}` | DELETE | 删除资源 | 删除按钮操作 |
| 6 | `/api/v1/dict/[type]` | GET | 获取字典配置 | 下拉选项数据源 |

> 按需增减。字典/枚举类接口用于填充下拉框、单选按钮等控件。

---

## 2. 通用约定

### 2.1 统一响应格式

```json
{
  "code": 200,
  "message": "success",
  "data": { }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| code | integer | 业务状态码：200 成功，其他为错误码 |
| message | string | 提示信息 |
| data | object/array/null | 业务数据 |

### 2.2 分页请求格式

```json
{
  "page": 1,
  "pageSize": 20,
  "sortBy": "created_at",
  "sortOrder": "desc"
}
```

### 2.3 分页响应格式

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 1024,
    "page": 1,
    "pageSize": 20,
    "list": [ ]
  }
}
```

### 2.4 错误码定义

| 错误码 | 含义 | 触发场景 |
|--------|------|---------|
| 200 | 成功 | 正常请求 |
| 400 | 参数错误 | 必填项缺失、格式不合法 |
| 401 | 未登录 / Token 过期 | 未携带有效认证信息 |
| 403 | 权限不足 | 角色无权执行该操作 |
| 404 | 资源不存在 | 请求的 ID 无对应记录 |
| 409 | 业务冲突 | 状态不允许操作（如已审核的订单再次提交） |
| 500 | 服务器内部错误 | 系统异常 |

### 2.5 认证方式

- **Header 要求：** `Authorization: Bearer <token>`
- **Content-Type：** `application/json`

---

## 3. 接口详细定义

### 3.1 获取列表

**路径：** `GET /api/v1/[resource]`

**功能：** 获取资源列表，支持筛选、分页、排序。

**Query 参数：**

| 参数名 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| page | integer | 否 | 页码，默认 1 | `?page=1` |
| pageSize | integer | 否 | 每页条数，默认 20，最大 100 | `?pageSize=20` |
| sortBy | string | 否 | 排序字段 | `?sortBy=created_at` |
| sortOrder | string | 否 | 排序方向：asc / desc | `?sortOrder=desc` |
| [filter_field_1] | string | 否 | [筛选字段说明] | `[field1]=value` |
| [filter_field_2] | integer | 否 | [筛选字段说明] | `[field2]=1` |

**响应体：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "list": [
      {
        "id": 1,
        "[field_1]": "value1",
        "[field_2]": 100,
        "createdAt": "2026-04-14T10:00:00Z",
        "updatedAt": "2026-04-14T10:00:00Z"
      }
    ]
  }
}
```

---

### 3.2 获取详情

**路径：** `GET /api/v1/[resource]/{id}`

**功能：** 获取单条资源的完整信息。

**Path 参数：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | integer/string | 是 | 资源主键 |

**响应体：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "[field_1]": "value1",
    "[field_2]": 100,
    "createdAt": "2026-04-14T10:00:00Z",
    "updatedAt": "2026-04-14T10:00:00Z"
  }
}
```

---

### 3.3 创建资源

**路径：** `POST /api/v1/[resource]`

**功能：** 新建一条资源记录。

**请求体：**

```json
{
  "[required_field_1]": "value1",
  "[required_field_2]": 100,
  "[optional_field_1]": "value2"
}
```

| 参数名 | 类型 | 必填 | 校验规则 | 说明 |
|--------|------|------|---------|------|
| [required_field_1] | string | 是 | [最大长度 50，不能为空] | [字段说明] |
| [required_field_2] | integer | 是 | [范围 1~9999] | [字段说明] |
| [optional_field_1] | string | 否 | [最大长度 200] | [字段说明] |

**响应体：**

```json
{
  "code": 200,
  "message": "创建成功",
  "data": {
    "id": 1
  }
}
```

---

### 3.4 更新资源

**路径：** `PUT /api/v1/[resource]/{id}`

**功能：** 更新一条资源记录。

**请求体：** 同创建接口，但所有字段为可选（仅更新提供的字段）。

**响应体：**

```json
{
  "code": 200,
  "message": "更新成功",
  "data": null
}
```

---

### 3.5 删除资源

**路径：** `DELETE /api/v1/[resource]/{id}`

**功能：** 删除一条资源记录（软删除或硬删除，参照系统设计文档约定）。

**响应体：**

```json
{
  "code": 200,
  "message": "删除成功",
  "data": null
}
```

---

### 3.6 [批量操作 / 自定义操作]

**路径：** `POST /api/v1/[resource]/[action]`

**功能：** [描述操作，如：批量审核、导出、状态流转]

**请求体：**

```json
{
  "ids": [1, 2, 3],
  "[action_param]": "value"
}
```

**响应体：**

```json
{
  "code": 200,
  "message": "操作成功",
  "data": {
    "successCount": 3,
    "failCount": 0,
    "failDetails": []
  }
}
```

---

### 3.7 获取字典/配置

**路径：** `GET /api/v1/dict/[type]`

**功能：** 获取下拉选项、枚举选项等配置数据。

**响应体：**

```json
{
  "code": 200,
  "message": "success",
  "data": [
    { "value": 1, "label": "选项A" },
    { "value": 2, "label": "选项B" }
  ]
}
```

---

## 4. 框架特定规范

> **此部分由技术栈发现步骤动态填充。**
>
> 根据所选技术栈，应用以下对应规范：
>
> - **Java + Spring Boot + MyBatis Plus：** 单表 CRUD 继承 BaseMapper，无需编写 XML Mapper；统一使用 `@RestController` + `@RequestMapping`；全局异常通过 `@ControllerAdvice` 拦截；返回统一 `Result<T>` 包装类。
> - **Python + FastAPI：** 使用 Pydantic BaseModel 定义请求/响应 Schema；依赖注入通过 `Depends()`；APIRouter 按模块拆分路由；自动生成交互式 OpenAPI 文档。
> - **Go + Gin + GORM：** 统一 `Response{Code, Message, Data}` 结构体；GORM struct tag 映射表字段；middleware 链式处理鉴权和日志；Gin binding 做请求校验。
> - **Node + NestJS：** DTO 类用 `class-validator` 装饰器校验；Entity 与 DTO 分离；Swagger 通过 `@ApiProperty` 自动生成文档；Service 注入 Repository。
