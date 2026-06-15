import json
import os
# Force redeploy 2026-02-04 V84
import datetime
import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key
# import pandas as pd (Deferred to avoid numpy binary incompatibility on login)
from urllib.parse import quote, urlencode
import urllib.request
import urllib.error
import base64

# --- Configuration ---
REGION = os.environ.get("AWS_REGION_OVERRIDE", "ap-northeast-1")
DYNAMODB_TABLE_MAIN = os.environ.get("DYNAMODB_TABLE_MAIN", "ActivityPacing_Main")
DYNAMODB_TABLE_LOGS = os.environ.get("DYNAMODB_TABLE_LOGS", "ActivityPacing_Logs")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0")
SES_SENDER_EMAIL = os.environ.get("SES_SENDER_EMAIL", "victory6341@gmail.com")

# --- Externalized config (set these as Lambda environment variables) ---
# 別AWSアカウントへ移行する際は、これらの環境変数を差し替えるだけで済むようにする。
# API Gateway の公開ベースURL (例: https://xxxx.execute-api.<region>.amazonaws.com/Prod)
API_BASE_URL = os.environ.get("API_BASE_URL", "https://i3ar4264ka.execute-api.ap-northeast-1.amazonaws.com/Prod")
# フロントエンドの公開URL (Fitbit連携完了後の戻り先)
FRONTEND_URL = os.environ.get("FRONTEND_URL", "https://dk3cg4zo1qjy9.cloudfront.net")
# Fitbit OAuth 認証情報 (シークレットは必ず環境変数 or Secrets Manager から)
FITBIT_CLIENT_ID = os.environ.get("FITBIT_CLIENT_ID", "23TRN8")
FITBIT_CLIENT_SECRET = os.environ.get("FITBIT_CLIENT_SECRET", "")

# Google Health API (Fitbit Web API の後継。2026年9月に旧Fitbit停止)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_HEALTH_SCOPE = os.environ.get(
    "GOOGLE_HEALTH_SCOPE",
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly"
)

# LINE Messaging API (プッシュ通知用)
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
# リマインドの「何分前」と、定期実行の間隔(=重複防止の窓)。EventBridgeの実行間隔と揃える。
REMINDER_LEAD_MIN = int(os.environ.get("REMINDER_LEAD_MIN", "10"))
REMINDER_WINDOW_MIN = int(os.environ.get("REMINDER_WINDOW_MIN", "10"))

# --- AWS Clients (Lazy Init if needed, but usually fine globally in Lambda) ---
dynamodb = boto3.resource('dynamodb', region_name=REGION)
table_main = dynamodb.Table(DYNAMODB_TABLE_MAIN)
table_logs = dynamodb.Table(DYNAMODB_TABLE_LOGS)
bedrock = boto3.client('bedrock-runtime', region_name=REGION)
ses = boto3.client('ses', region_name=REGION)

from decimal import Decimal

class DecimalEncoder(json.JSONEncoder):
    """
    Helper class to allow JSON serialization of Decimal objects (common in DynamoDB).
    """
    def default(self, o):
        if isinstance(o, Decimal):
            if o % 1 == 0:
                return int(o)
            return float(o)
        return super(DecimalEncoder, self).default(o)

def convert_floats_to_decimals(obj):
    """
    Recursively converts float values to Decimal for DynamoDB compatibility.
    """
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: convert_floats_to_decimals(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [convert_floats_to_decimals(v) for v in obj]
    return obj

def create_response(status_code, body):
    """
    Helper to generate API Gateway response with CORS headers.
    """
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,PUT,PATCH,DELETE',
            'X-App-Backend-Version': '20260206_v87'
        },
        'body': json.dumps(body, cls=DecimalEncoder, ensure_ascii=False)
    }

# --- Routing Map ---
# Maps normalized paths and HTTP methods to handler functions
ROUTES = {
    '/proposal': {'POST': 'handle_proposal'},
    '/logs': {'POST': 'handle_log'},
    '/notify': {'POST': 'send_notification'},
    '/export': {'GET': 'handle_export'},
    '/favicon.ico': {'GET': 'handle_favicon'}, # Special case, handled directly
    
    # Fitbit Integration
    '/fitbit/auth': {'GET': 'handle_fitbit_auth'}, # Assuming GET for initial auth redirect
    '/fitbit/steps': {'GET': 'handle_fitbit_steps'}, # Assuming GET for fetching steps
    '/fitbit/callback': {'GET': 'handle_fitbit_callback'}, # Fitbit callback is typically GET
    
    # Google Health (Fitbit後継)
    '/health/auth': {'GET': 'handle_health_auth'},
    '/health/callback': {'GET': 'handle_health_callback'},
    '/health/steps': {'GET': 'handle_health_steps'},

    # New routes
    '/auth/line': {'POST': 'login_with_line'},
    '/subjects/{id}/link': {'POST': 'link_line_id'}, # New route for linking

    # Generic CRUD for valid_resources
    '/{resource_type}': {
        'GET': 'list_items',
        'POST': 'create_item'
    },
    '/{resource_type}/{id}': {
        'GET': 'get_item_data',
        'POST': 'create_item', # Can be used for update if ID is provided in body/path
        'PUT': 'create_item', # Explicitly for update
        'PATCH': 'patch_item',
        'DELETE': 'delete_item'
    }
}

VALID_RESOURCES = ['exercises', 'projects', 'subjects', 'categories', 'columns']

def lambda_handler(event, context):
    """
    Unified Lambda Handler for API Gateway.
    Routes based on resourcePath and httpMethod.
    """
    print("Received event:", json.dumps(event))

    # スケジュール実行(EventBridge)からの呼び出し。API Gatewayイベントではない。
    sched_task = event.get('task')
    if sched_task == 'reminders':
        return {'statusCode': 200, 'sent': run_scheduled_reminders()}
    if sched_task == 'daily_ai':
        return {'statusCode': 200, 'sent': run_daily_ai_push()}

    # Handle preflight request (OPTIONS)
    if event.get('httpMethod') == 'OPTIONS':
        return create_response(200, {})

    try:
        method = event.get('httpMethod', 'GET')
        path_raw = event.get('path', '/')
        path_clean = path_raw.strip('/')
        parts = [p for p in path_clean.split('/') if p]
        
        # Prodなどのステージ名を除去
        if parts and parts[0] in ['Prod', 'Stage', 'v1']:
            parts.pop(0)

        # ルーティング判定開始
        if not parts:
            return create_response(200, {'message': 'Exercise Oncology API is running'})

        # 1. LINE認証関連
        elif parts[0] == 'auth' and len(parts) > 1 and parts[1] == 'line':
            body = json.loads(event.get('body', '{}'))
            return login_with_line(body)

        # 2. AI提案機能 (POST /proposal)
        elif parts[0] == 'proposal':
            return handle_proposal(event)

        # 3. Fitbit連携関連
        elif parts[0] == 'fitbit':
            if len(parts) > 1:
                if parts[1] == 'callback':
                    return handle_fitbit_callback(event)
                elif parts[1] == 'auth':
                    return handle_fitbit_auth(event)
                elif parts[1] == 'steps':
                    return handle_fitbit_steps(event)
            return create_response(404, {'error': 'Fitbit sub-route not found'})

        # 3.5 Google Health 連携 (Fitbit後継)
        elif parts[0] == 'health':
            if len(parts) > 1:
                if parts[1] == 'auth':
                    return handle_health_auth(event)
                elif parts[1] == 'callback':
                    return handle_health_callback(event)
                elif parts[1] == 'steps':
                    return handle_health_steps(event)
            return create_response(404, {'error': 'Health sub-route not found'})

        # 4. Favicon (Ignore or simple response)
        elif parts[0] == 'favicon.ico':
            return { 
                'statusCode': 204, 
                'headers': { 'Content-Type': 'image/x-icon' },
                'body': '' 
            }

        # 4. 被験者データ連携 (subjects/{id}/link)
        elif parts[0] == 'subjects' and len(parts) == 3 and parts[2] == 'link':
            subject_id = parts[1]
            body = json.loads(event.get('body', '{}'))
            return link_line_id(subject_id, body)

        # 5. その他ログやエクスポート
        elif parts[0] == 'logs':
            return handle_log(event)
        elif parts[0] == 'export':
            return handle_export()

        # 6. 基本リソース (subjects, exercises, projects)
        elif parts[0] in VALID_RESOURCES:
            resource_type = parts[0]
            
            # Collection Level: /exercises, /projects
            if len(parts) == 1:
                if method == 'GET':
                    return list_items(resource_type)
                elif method in ['POST', 'PUT']:
                    return save_item(resource_type, event)
            
            # Item Level: /subjects/{id}
            elif len(parts) == 2:
                item_id = parts[1]
                if method == 'GET':
                    return get_subject_data(item_id) if resource_type == 'subjects' else get_item(resource_type, item_id)
                elif method in ['POST', 'PUT']:
                    # 被験者データの更新（スケジュール保存など）
                    return save_item(resource_type, event, item_id)
                elif method == 'PATCH':
                    return patch_item(resource_type, event, item_id)
                elif method == 'DELETE':
                    return delete_item(resource_type, item_id)

        # どこにも該当しない場合
        return create_response(404, {'error': f'Route {method} {path_raw} not found'})

    except Exception as e:
        import traceback
        print(f"Unhandled Error: {e}")
        print(traceback.format_exc()) # エラー詳細をログに出す
        return create_response(500, {'error': str(e)})

# --- CRUD Logic ---

def list_items(resource_type):
    """
    Scans DynamoDB for items with PK 'param' starting with RESOURCE_TYPE_PREFIX.
    Mapping:
    exercises -> EXERCISE
    projects -> PROJECT
    subjects -> SUBJECT
    categories -> CATEGORY
    columns -> COLUMN
    """
    prefix_map = {
        'exercises': 'EXERCISE',
        'projects': 'PROJECT',
        'subjects': 'SUBJECT',
        'categories': 'CATEGORY',
        'columns': 'COLUMN'
    }
    
    prefix = prefix_map.get(resource_type)
    if not prefix:
         return create_response(400, {'error': 'Invalid resource'})
    
    try:
        # Using Scan with FilterExpression
        # Note: In a production environment with millions of items, a GSI with PK=Type would be better.
        # For this master data table, Scan is acceptable.
        from boto3.dynamodb.conditions import Attr
        
        response = table_main.scan(
            FilterExpression=Attr('param').begins_with(f"{prefix}#")
        )
        items = response.get('Items', [])
        
        # Unpack 'data' content
        unpacked = []
        for i in items:
            # Our data model stores the actual object in 'data' attribute, 
            # and the key in 'param'. 
            d = i.get('data', i).copy() # Copy to avoid mutation issues if ref returned
            
            # Ensure ID is included in the responding object
            if 'id' not in d:
                # Try to extract from param: EXERCISE#101 -> 101
                try:
                    d['id'] = i['param'].split('#')[1]
                except:
                    pass
            unpacked.append(d)
        
        # Sort by ID if possible (integer sort preferred)
        try:
             unpacked.sort(key=lambda x: int(x.get('id', 0)))
        except:
             # Fallback to string sort
             unpacked.sort(key=lambda x: str(x.get('id', '')))

        return create_response(200, unpacked)
    except Exception as e:
        print(f"List Items Error ({resource_type}): {e}")
        return create_response(500, {'error': str(e)})

def save_item(resource_type, event, item_id=None):
    prefix_map = {
        'exercises': 'EXERCISE',
        'projects': 'PROJECT',
        'subjects': 'SUBJECT',
        'categories': 'CATEGORY',
        'columns': 'COLUMN'
    }
    prefix = prefix_map.get(resource_type)
    
    try:
        body = json.loads(event.get('body', '{}'))
        body = convert_floats_to_decimals(body)
    except json.JSONDecodeError:
        return create_response(400, {'error': 'Invalid JSON body'})

    if not item_id:
        item_id = body.get('id')
    
    if not item_id:
         # Auto-generate ID?
         item_id = str(int(datetime.datetime.now().timestamp() * 1000))
         body['id'] = item_id

    # --- ID 1-99 Protection Logic ---
    # 研究用IDやシステムIDを誤って上書きから守る
    # v53: ID "1" はテスト・デモ用として許可するように緩和
    if resource_type == 'subjects' and item_id in ["demo_pt"]:
        try:
            existing = table_main.get_item(Key={'param': f"{prefix}#{item_id}"})
            if 'Item' in existing:
                print(f"STRICT PROTECTION: Rejecting update to protected ID: {item_id}")
                return create_response(403, {'error': f'ID {item_id} is protected and cannot be modified via this endpoint.'})
        except Exception as e:
            print(f"Protection check failed: {e}")

    try:
        item = {
            'param': f"{prefix}#{item_id}",
            'data': body
        }
        table_main.put_item(Item=item)
        return create_response(200, body)
    except Exception as e:
        return create_response(500, {'error': str(e)})

def patch_item(resource_type, event, item_id):
    prefix_map = {
        'exercises': 'EXERCISE',
        'projects': 'PROJECT',
        'subjects': 'SUBJECT',
        'categories': 'CATEGORY',
        'columns': 'COLUMN'
    }
    prefix = prefix_map.get(resource_type)
    if not prefix:
        return create_response(400, {'error': 'Invalid resource'})

    try:
        body = json.loads(event.get('body', '{}'))
        body = convert_floats_to_decimals(body)
    except json.JSONDecodeError:
        return create_response(400, {'error': 'Invalid JSON body'})

    if not item_id:
        return create_response(400, {'error': 'Item ID is required for PATCH'})

    try:
        # Use simple SET #d.#field = :val for flat merge into 'data' attribute
        update_expr = "SET "
        attr_values = {}
        attr_names = {"#d": "data"}
        
        for key, value in body.items():
            # Create a safe placeholder key (no hyphens)
            safe_key = key.replace('-', '_')
            update_expr += f"#d.#field_{safe_key} = :val_{safe_key}, "
            attr_names[f"#field_{safe_key}"] = key
            attr_values[f":val_{safe_key}"] = value
        
        update_expr = update_expr.rstrip(", ")
        
        table_main.update_item(
            Key={'param': f"{prefix}#{item_id}"},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=attr_names,
            ExpressionAttributeValues=attr_values,
            ReturnValues="ALL_NEW"
        )
        return create_response(200, body)
    except Exception as e:
        print(f"Patch Item Error: {e}")
        return create_response(500, {'error': str(e)})

def delete_item(resource_type, item_id):
    prefix_map = {
        'exercises': 'EXERCISE',
        'projects': 'PROJECT',
        'subjects': 'SUBJECT',
        'categories': 'CATEGORY',
        'columns': 'COLUMN'
    }
    prefix = prefix_map.get(resource_type)
    
    try:
        table_main.delete_item(
            Key={'param': f"{prefix}#{item_id}"}
        )
        return create_response(200, {'status': 'deleted'})
    except Exception as e:
        return create_response(500, {'error': str(e)})

def get_item(resource_type, item_id):
    prefix_map = {
        'exercises': 'EXERCISE',
        'projects': 'PROJECT',
        'subjects': 'SUBJECT',
        'categories': 'CATEGORY',
        'columns': 'COLUMN'
    }
    prefix = prefix_map.get(resource_type)
    
    try:
        resp = table_main.get_item(Key={'param': f"{prefix}#{item_id}"})
        item = resp.get('Item')
        if not item:
            return create_response(404, {'error': 'Not found'})
        
        return create_response(200, item.get('data', item))
    except Exception as e:
        return create_response(500, {'error': str(e)})

# --- Core Business Logic ---

def handle_proposal(event):
    """
    Generates activity proposal based on user condition and history.
    """
    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return create_response(400, {'error': 'Invalid JSON body'})

    subject_id = body.get('subjectId') or body.get('userId')
    current_cond = body.get('currentCondition')
    
    if not subject_id or not current_cond:
        return create_response(400, {'error': 'Missing subjectId or currentCondition'})

    # 1. Fetch User Data & History (Resilient to pandas failure)
    try:
        user_data, df_logs = analyze_user_data(subject_id)
    except Exception as e:
        print(f"User data analysis fallback due to error: {e}")
        user_data = {}
        df_logs = None # We'll handle None in determine_mode

    # 2. Determine Mode
    try:
        mode, reason, history_insight = determine_mode(df_logs, current_cond)
    except Exception as e:
        print(f"Mode determination fallback: {e}")
        mode, reason, history_insight = "Normal", "自動判定に失敗したため、通常モードを推奨します。", ""

    # --- New: Addon Proposal Logic (Gap based) ---
    gap_list = body.get('gapList')
    if gap_list:
        print(f"Processing Addon Proposal for {len(gap_list)} gaps")
        try:
            # Generate a specific addon suggestion based on gaps
            suggestion = generate_message_bedrock(
                mode, reason, current_cond, 
                history_insight=history_insight, 
                gap_list=gap_list
            )
            
            # 予定の抽出 (AIからの追加提案：14:30からスクワットを... -> time: 14:30, title: スクワット)
            import re
            match = re.search(r'提案：(\d{1,2}:\d{2})から(.*?)を', suggestion)
            addon_schedule = []
            if match:
                time_str, activity_name = match.groups()
                h, m = map(int, time_str.split(':'))
                addon_schedule.append({
                    "title": activity_name,
                    "startMinute": h * 60 + m,
                    "duration": 15,
                    "isAI": True,
                    "isDone": False
                })

            return create_response(200, {
                "mode": mode,
                "suggestion": suggestion, # Backward compatibility
                "comment": suggestion,    # New standard
                "daily_schedule": addon_schedule,
                "timestamp": datetime.datetime.now().isoformat()
            })
        except Exception as e:
            print(f"Addon proposal error: {e}")
            import traceback
            print(traceback.format_exc())
            return create_response(200, {
                "mode": mode,
                "suggestion": "申し訳ありません。プランの自動調整中にエラーが発生しました。通常通り活動を続けてください。",
                "comment": "AIによる自動調整に失敗しました。",
                "daily_schedule": [],
                "error_detail": str(e)
            })

    # 3. Calculate Schedule (Standard Daily Proposal)
    now_jst = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
    suggested_schedule = calculate_next_slots(now_jst)

    # 4. Generate Message via Bedrock with Fallback
    try:
        message = generate_message_bedrock(mode, reason, current_cond, history_insight, suggested_schedule)
    except Exception as e:
        print(f"AI message generation fallback: {e}")
        if mode == "Warning":
            message = "今日は無理をせず、ゆったりとした時間を過ごすことをお勧めします。痛みや疲れがある場合は、心身の休息を優先しましょう。"
        elif mode == "Challenge":
            message = "今日の体調は素晴らしいですね！少し活動強度を上げて、新しい運動にチャレンジしてみませんか？"
        else:
            message = "いつものペースで活動しましょう。座りすぎに注意して、適度に体を動かしてください。"

    # 5. Build Schedule (daily_schedule format)
    # 実際のアドバイス文から具体名（提案：17:00から散歩 等）を抽出
    import re
    # 柔軟な正規表現: "提案：17:00から散歩", "17:00頃に軽い運動をしましょう" 等に対応
    found_patterns = re.findall(r'(?:提案：)?(\d{1,2}:\d{2})(?:頃)?(?:から|に|、)?(.*?)(?:を|しましょう|します|頂ければ|お勧め|推奨)', message)
    extracted_activities = {}
    for t_str, act in found_patterns:
        try:
            h = int(t_str.split(':')[0])
            if 0 <= h < 24:
                # クリーニング: 文末の句点や余計な記号を削除し、短縮（15文字以内）
                clean_act = re.split(r'[。！!？?、]', act.strip())[0][:15]
                extracted_activities[h] = clean_act
        except: pass

    # Format: Array of 19 items (05:00 to 24:00)
    daily_schedule = [None] * 19
    # Add slots based on suggested_schedule
    for time_str in suggested_schedule:
        try:
            if "明日" in time_str: continue 
            hour = int(time_str.split(":")[0])
            idx = hour - 5 # 05:00 is index 0
            if 0 <= idx < 19:
                # 抽出された名前があれば採用、なければフォールバック
                activity_name = extracted_activities.get(hour)
                if not activity_name:
                    activity_name = "推奨アクション"
                    if mode == "Warning": activity_name = "深呼吸・リラックス"
                    elif mode == "Challenge": activity_name = "アクティブ運動"
                
                daily_schedule[idx] = {
                    "title": activity_name if activity_name.startswith("AI提案:") else f"AI提案: {activity_name}",
                    "duration": 5 if mode == "Warning" else 15,
                    "isDone": False,
                    "isAI": True
                }
        except: pass

    # 6. Result
    result_data = {
        "mode": mode,
        "reason": reason,
        "message": message,
        "suggested_schedule": suggested_schedule,
        "daily_schedule": daily_schedule,
        "timestamp": datetime.datetime.now().isoformat()
    }
    
    return create_response(200, result_data)


def handle_log(event):
    """
    Saves a log entry (Activity, Condition) to both Logs table (for analysis) and Main table (for UI).
    Dual-write strategy ensures consistency between historical analysis and frontend state.
    """
    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return create_response(400, {'error': 'Invalid JSON body'})

    subject_id = body.get('subjectId')
    raw_log = body.get('log')

    if not subject_id or not raw_log:
        return create_response(400, {'error': 'Missing subjectId or log object'})

    # Convert floats to Decimals for DynamoDB
    log_entry = convert_floats_to_decimals(raw_log)

    # 1. Write to ActivityPacing_Logs (Analysis DB)
    try:
        # Ensure PK/SK exist
        # Use JST for timestamp
        now_jst = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
        timestamp = log_entry.get('date', now_jst.isoformat())
        
        log_item = {
            'subjectId': str(subject_id), # PK
            'timestamp': timestamp,       # SK
            'type': log_entry.get('type', 'unknown'),
            'log_data': log_entry         # Store full JSON payload
        }
        table_logs.put_item(Item=log_item)

    except Exception as e:
        print(f"Failed to write to Logs table: {e}")

    # 2. Append to ActivityPacing_Main (UI DB)
    try:
        table_main.update_item(
             Key={'param': f'SUBJECT#{subject_id}'},
             UpdateExpression="SET #d.#l = list_append(if_not_exists(#d.#l, :empty_list), :new_log)",
             ExpressionAttributeNames={
                 '#d': 'data',
                 '#l': 'logs'
             },
             ExpressionAttributeValues={
                 ':new_log': [log_entry],
                 ':empty_list': []
             }
        )
        return create_response(200, {'status': 'success', 'saved_log': log_entry})
        
    except ClientError as e:
        # If 'data' map doesn't exist, update_item fails. We need to create it.
        if e.response['Error']['Code'] == 'ValidationException':
             try:
                # Fallback: Create 'data' with 'logs'
                # Note: This technically overwrites 'data' if it was a non-Map type, but it shouldn't be.
                # If 'data' didn't exist, this creates it.
                # Use a condition to be safe? No, if the previous failed, it's missing or wrong type.
                table_main.update_item(
                    Key={'param': f'SUBJECT#{subject_id}'},
                    UpdateExpression="SET #d = :init_val",
                    ExpressionAttributeNames={'#d': 'data'},
                    ExpressionAttributeValues={':init_val': {'logs': [log_entry]}}
                )
                return create_response(200, {'status': 'success', 'saved_log': log_entry, 'note': 'initialized data'})
             except Exception as inner_e:
                 print(f"Fallback update failed: {inner_e}")
                 return create_response(500, {'error': f"Update failed: {str(e)} -> {str(inner_e)}"})
        
        print(f"Failed to update Main table: {e}")
        return create_response(500, {'error': str(e)})
    except Exception as e:
        print(f"Unknown error updating Main table: {e}")
        return create_response(500, {'error': str(e)})

def get_subject_data(subject_id):
    """
    Fetches subject profile from DynamoDB.
    """
    try:
        # Fetch from Main table
        resp = table_main.get_item(Key={'param': f'SUBJECT#{subject_id}'})
        item = resp.get('Item', {})
        
        if not item:
            return create_response(404, {'error': 'Subject not found'})
            
        # Unpack JSON logic if stored as string, or return raw dict
        # We assume attributes are stored directly or in a 'data' map.
        # Design choice: Store flat attributes for easier indexing? 
        # For this migration, let's assume 'data' attribute holds the JSON object to minimize schema mapping effot.
        user_data = item.get('data', item) 
        
        return create_response(200, user_data)
    except Exception as e:
         return create_response(500, {'error': str(e)})

def send_notification(event):
    """
    Sends email notification via SES (Replacing FCM).
    """
    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return create_response(400, {'error': 'Invalid JSON body'})

    subject_id = body.get('subjectId')
    message_body = body.get('message')
    
    if not subject_id or not message_body:
        return create_response(400, {'error': 'Missing params'})

    # 1. Get User Email
    # Fetch from DynamoDB
    resp = table_main.get_item(Key={'param': f'SUBJECT#{subject_id}'})
    item = resp.get('Item')
    
    if not item:
        return create_response(404, {'error': 'User not found'})
        
    user_data = item.get('data', item)
    email = user_data.get('email')
    
    if not email:
        return create_response(400, {'error': 'User has no email registered'})

    # 2. Send SES Email
    try:
        ses.send_email(
            Source=SES_SENDER_EMAIL,
            Destination={'ToAddresses': [email]},
            Message={
                'Subject': {'Data': 'Activity Pacing Notification'},
                'Body': {'Text': {'Data': message_body}}
            }
        )
        return create_response(200, {'status': 'success'})
    except Exception as e:
         return create_response(500, {'error': str(e)})


# --- Helper Functions ---

def analyze_user_data(subject_id):
    """
    Fetches logs from DynamoDB (ActivityPacing_Logs) and returns DataFrame.
    """
    try:
        # Query Logs Table
        # KeyCondition: user_id = subject_id
        # We might need to limit query to recent logs if data is huge.
        response = table_logs.query(
            KeyConditionExpression=Key('subjectId').eq(str(subject_id))
        )
        items = response.get('Items', [])
        
        # Also get user profile for consistency if needed, but main.py returned (data, df)
        # We'll fetch profile briefly
        profile_resp = table_main.get_item(Key={'param': f'SUBJECT#{subject_id}'})
        user_data = profile_resp.get('Item', {}).get('data', {})

        if not items:
            import pandas as pd
            return user_data, pd.DataFrame()
            
        # DynamoDB items to DataFrame
        import pandas as pd
        df = pd.DataFrame(items)
        
        # Expand 'log_data' Map if it exists (Recommended pattern: subjectId, timestamp, ...attributes)
        # If we stored log details inside a 'log_data' map:
        if 'log_data' in df.columns:
            # Flatten log_data
            data_df = pd.json_normalize(df['log_data'])
            # Drop log_data before concat
            df = df.drop(columns=['log_data']).reset_index(drop=True)
            data_df = data_df.reset_index(drop=True)
            
            # Remove columns from data_df that already exist in df to avoid duplicates
            data_df = data_df.drop(columns=[c for c in data_df.columns if c in df.columns], errors='ignore')
            
            df = pd.concat([df, data_df], axis=1)
            
        # Ensure date/timestamp handling compatible with logic
        # main.py expects 'date' column. DynamoDB 'timestamp' (SK) serves this.
        if 'timestamp' in df.columns and 'date' not in df.columns:
            df['date'] = pd.to_datetime(df['timestamp'])
        elif 'date' in df.columns:
             df['date'] = pd.to_datetime(df['date'])

        return user_data, df
    
    except Exception as e:
        print(f"Error checking user data: {e}")
        try:
            import pandas as pd
            return {}, pd.DataFrame()
        except:
            return {}, None

def determine_mode(df_logs, current_cond):
    """
    [LOGIC PRESERVED FROM main.py]
    4.2 Mode Determination Logic
    """
    try:
        import pandas as pd
    except ImportError:
        return "Normal", "分析ライブラリが利用できないため、通常モードを推奨します。", ""
    # Unpack current condition
    # Support new naming convention from OpenAPI (V141+)
    def get_val(key_new, key_old, default):
        val = current_cond.get(key_new)
        if val is None:
            val = current_cond.get(key_old, default)
        return val

    fatigue = int(get_val("fatigue_0_10", "fatigue", 5))
    pain = int(get_val("pain_0_10", "pain", 0))
    sleep_val = get_val("sleep_quality", "sleep", 1)
    
    # Mapping sleep_quality (0=poor, 1=ok, 2=good) to legacy strings if needed
    sleep_quality = "ok"
    if isinstance(sleep_val, int):
        sleep_quality = {0: "poor", 1: "ok", 2: "good"}.get(sleep_val, "ok")
    else:
        sleep_quality = str(sleep_val)

    mood = current_cond.get("mood", "mid")
    hrv = current_cond.get("hrv", "normal") 

    # --- 1. Pattern Analysis ---
    failure_pattern_found = False
    failure_reason = ""
    history_insight = "" # New: Text summary of past similar days
    
    if df_logs is not None and not df_logs.empty and 'pain' in df_logs.columns and 'date' in df_logs.columns:
        df_logs = df_logs.sort_values('date')
        now = pd.Timestamp.now(tz='UTC')
        recent_logs = df_logs[df_logs['date'] >= (now - pd.Timedelta(days=30))]
        
        # Similar condition days (Fatigue +/- 1)
        if not recent_logs.empty and 'type' in recent_logs.columns:
             # Make sure fatigue is numeric
             recent_logs['fatigue'] = pd.to_numeric(recent_logs['fatigue'], errors='coerce')
             recent_logs['pain'] = pd.to_numeric(recent_logs['pain'], errors='coerce')
             
             similar_days = recent_logs[
                (recent_logs['type'] == 'condition') & 
                (recent_logs['fatigue'].between(fatigue - 1, fatigue + 1))
             ]
             
             # A. Check Bad Outcomes (Pain >= 2 on similar days)
             high_pain_days = similar_days[similar_days['pain'] >= 2]
             
             if not high_pain_days.empty:
                 failure_pattern_found = True
                 failure_reason = "過去に似た体調の日に痛みが強くなった記録があります。"
                 history_insight = f"警告: 過去の類似日({high_pain_days.iloc[-1]['date'].strftime('%m/%d')})に痛みが増加しました。"
             
             # B. Check Good Outcomes (Success Pattern)
             # If no failure, checking for success
             elif not similar_days.empty:
                 # Find days where they did activity?
                 # Need to join with activity logs of the SAME day or check if pain stayed low
                 # Simple check: Similar days with Low Pain?
                 success_days = similar_days[similar_days['pain'] <= 1]
                 if not success_days.empty:
                     last_success = success_days.iloc[-1]
                     history_insight = f"成功例: 過去の類似日({last_success['date'].strftime('%m/%d')})は痛みなく過ごせています。"

    # --- 2. Logic Tree ---

    # Priority 1: Warning Mode
    if failure_pattern_found:
        return "Warning", f"失敗パターン検知: {failure_reason}", history_insight
    
    if hrv == "low":
        return "Warning", "HRVデータが低下しており、疲労の蓄積が示唆されます。", history_insight
        
    if pain >= 2: 
        return "Warning", f"現在の痛みレベル({pain})が高い状態です。", history_insight


    # Priority 2: Challenge Mode
    is_condition_good = fatigue <= 2
    is_pain_low = pain <= 1
    is_recovery_ok = (sleep_quality in ["good", "ok"]) and (hrv in ["normal", "high"])
    
    if is_condition_good and is_pain_low and is_recovery_ok:
        return "Challenge", "体調・痛み・リカバリー状態がすべて良好です。", history_insight


    # Priority 3: Normal Mode
    return "Normal", "特筆すべきリスクや絶好調要因が見当たらないため、通常運転を推奨します。", history_insight


def handle_export():
    """
    Exports all data from ActivityPacing_Logs for CSV conversion.
    """
    try:
        # 1. Scan Logs Table
        # Note: 'scan' can be slow for very large datasets, but acceptable for research app scale.
        response = table_logs.scan()
        items = response.get('Items', [])
        
        # Handle pagination if needed (LastEvaluatedKey) - Simplified for now
        while 'LastEvaluatedKey' in response:
            response = table_logs.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))
            
        # 2. Process & Flatten
        export_data = []
        for item in items:
            # Basic keys
            flat_item = {
                'subjectId': item.get('subjectId'),
                'timestamp': item.get('timestamp')
            }
            
            # Helper to Flatten 'data' or 'log_data'
            # Based on previous logic, logs might be in 'log_data' (from seed) or root attributes
            # Let's try to flatten everything recursively or just top-level
            for k, v in item.items():
                if k not in ['subjectId', 'timestamp']:
                    flat_item[k] = v
            
            export_data.append(flat_item)
            
        # 3. Sort by subject and time
        export_data.sort(key=lambda x: (x.get('subjectId', ''), x.get('timestamp', '')))
        
        return create_response(200, export_data)
        
    except Exception as e:
        print(f"Export Error: {e}")
        return create_response(500, {'message': str(e)})


def calculate_next_slots(now_jst):
    """
    Determines next 2 schedule slots based on current time.
    Target: 3-4 times a day.
    Slots: 07:00, 10:00, 14:00, 17:00, 20:00 (Example)
    """
    fixed_slots = [7, 10, 14, 17, 20]
    current_hour = now_jst.hour
    
    next_slots = []
    # Find next today
    for h in fixed_slots:
        if h > current_hour:
            next_slots.append(f"{h:02d}:00")
            if len(next_slots) >= 2: break
            
    # If not enough, add tomorrow
    if len(next_slots) < 2:
        for h in fixed_slots:
            next_slots.append(f"明日{h:02d}:00")
            if len(next_slots) >= 2: break
            
    return next_slots

def generate_message_bedrock(mode, reason, current_cond, history_insight="", suggested_schedule=[], gap_list=None):
    """
    [MODIFIED for AWS Bedrock]
    5. AI Prompt Engineering using Claude 3.5 Sonnet
    """
    
    persona = """
    あなたは運動腫瘍学の専門知識を持ち、ユーザーの痛みと辛さに寄り添うパートナーです。
    無理強いはせず、データに基づいた客観的なアドバイスを行います。
    ユーザーはがんサバイバーであり、「動きたいけど痛みが怖い」あるいは「頑張りすぎてしまう」傾向があります。
    """
    
    # Check time for scheduling (JST approx by adding 9h to UTC)
    # Lambda environment time handling usually implies UTC.
    now_jst = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
    current_time_str = now_jst.strftime("%H:%M")
    
    is_addon = gap_list is not None
    
    if is_addon:
        # Pacing/Contrast Specific Prompt
        gaps_desc = ""
        for i, gap in enumerate(gap_list[:3]):
            start_m = gap.get('startMinute', 0)
            duration = gap.get('duration') or gap.get('planned_duration_min', 0)
            prev = gap.get('prevActivity', '不明')
            nxt = gap.get('nextActivity', '不明')
            gaps_desc += f"- 隙間{i+1}: {start_m//60:02d}:{start_m%60:02d}から{duration}分間 (前: {prev}, 後: {nxt})\n"
        
        instruction = f"""
        【指示: 追加提案モード】
        現在スケジュールにある「隙間時間」を有効活用するための、1つだけの具体的な活動提案を行ってください。
        
        強度のメリハリ（ペーシング）を最も重視してください：
        - 前後の活動が『デスクワーク』など静的なものなら『立ち上がってスクワット』や『家の中を歩く』などの動的な活動を。
        - 前の活動が『散歩』など動的なもので、次が『家事』なら『今は座って深呼吸で呼吸を整える』などの静的な休息を。
        
        以下の隙間リストから最適な1つを選び、140文字以内で理由とともに提案してください：
        {gaps_desc}
        
        回答は必ず以下の形式にしてください：
        「AIからの追加提案：[開始時刻(HH:mm)]から[活動名]をしませんか？[理由と励まし]」
        """
    else:
        # Standard Daily Proposal Prompt
        schedule_text = "、".join(suggested_schedule) if suggested_schedule else "適宜"
        instruction = f"""
        【システム判定】
        - 判定モード: {mode} (Warning / Challenge / Normal)
        - 判定根拠: {reason}
        - 過去データの傾向: {history_insight}
        - 推奨スケジュール: {schedule_text}
        
        【指示: デイリー提案モード】
        モードに応じたメッセージを、140文字以内で作成してください。以下の構成を含めてください。
        1. **共感と分析**: {history_insight} がある場合は必ず触れてください。
        2. **モード別アドバイス**: 休む、または自信を持たせる、または現状維持。
        3. **具体的なスケジュール提案**: 
           「提案：{suggested_schedule[0]}から[活動名]」という形式を必ず含めてください（時間は推奨スケジュールの中から選んでください）。
        """

    context_text = f"""
    【現在時刻 (JST)】
    {current_time_str}
    
    【ユーザー状態】
    - 疲労感: {current_cond.get('fatigue_0_10') or current_cond.get('fatigue', 5)} (0-10)
    - 痛み: {current_cond.get('pain_0_10') or current_cond.get('pain', 0)} (0-10)
    - 気分: {current_cond.get('mood', '普通')}
    - HRV(自律神経): {current_cond.get('hrv', '正常')}
    - 睡眠: {current_cond.get('sleep_quality') if current_cond.get('sleep_quality') is not None else current_cond.get('sleep', '普通')}
    
    {instruction}
    """
    
    # Bedrock Request Body for Claude 3
    # Format: { "anthropic_version": "bedrock-2023-05-31", "max_tokens": 150, "messages": [...] }
    prompt_payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 150,
        "temperature": 0.7,
        "messages": [
            {
                "role": "user",
                "content": f"{persona}\n\n{context_text}"
            }
        ]
    }

    try:
        response = bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            body=json.dumps(prompt_payload)
        )
        
        response_body = json.loads(response.get('body').read())
        # Claude response structure: content -> [ { "text": "..." } ]
        content = response_body.get('content', [])
        if content:
            return content[0].get('text', '').strip()
        else:
            return "メッセージを生成できませんでした。"

    except Exception as e:
        print(f"Bedrock generation error: {e}")
        # Fallback messages
        if mode == "Warning": return "今日は体を休めることが最優先です。無理せずリラックスしましょう。"
        if mode == "Challenge": return "コンディションは良好です！少し負荷をかけた運動に挑戦してみましょう。"
        return "いつものペースで活動しましょう。座りすぎに注意して、適度に動いてください。"

# --- Fitbit Handlers ---

def handle_fitbit_auth(event):
    params = event.get('queryStringParameters') or {}
    subject_id = params.get('subjectId', 'unknown')
    
    # Config (環境変数から)
    redirect_uri = f"{API_BASE_URL}/fitbit/callback"
    client_id = FITBIT_CLIENT_ID
    scope = "activity profile heartrate sleep"
    
    # State should be subjectId to return to user
    state = subject_id
    
    auth_url = (
        f"https://www.fitbit.com/oauth2/authorize?response_type=code"
        f"&client_id={client_id}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&scope={quote(scope)}"
        f"&expires_in=604800"
        f"&state={state}"
    )
    
    return {
        'statusCode': 302,
        'headers': {
            'Location': auth_url,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'X-App-Backend-Version': '20260204_v75'
        },
        'body': ''
    }

def handle_fitbit_steps(event):
    params = event.get('queryStringParameters') or {}
    subject_id = params.get('subjectId')
    
    if not subject_id:
        return create_response(400, {'error': 'Missing subjectId'})

    client_id = FITBIT_CLIENT_ID
    client_secret = FITBIT_CLIENT_SECRET

    try:
        # 1. Get Token from DB
        user_res = table_main.get_item(Key={'param': f'SUBJECT#{subject_id}'})
        item = user_res.get('Item')
        if not item:
            return create_response(404, {'error': 'User not found'})
            
        user_data = item.get('data', item)
        token_data = user_data.get('fitbit_token')
        
        if not token_data or 'access_token' not in token_data:
            return create_response(200, {'steps': 0, 'steps_yesterday': 0, 'status': 'no_token'})
            
        access_token = token_data['access_token']
        refresh_token = token_data.get('refresh_token')

        def fetch_with_refresh(url, token, retry=True):
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
            try:
                with urllib.request.urlopen(req) as res:
                    return json.loads(res.read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 401 and retry and refresh_token:
                    print(f"Token expired for {subject_id}, attempting refresh...")
                    # Refresh Token
                    auth_str = f"{client_id}:{client_secret}"
                    b64_auth = base64.b64encode(auth_str.encode()).decode()
                    refresh_data = urlencode({
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token
                    }).encode('utf-8')
                    
                    refresh_req = urllib.request.Request(
                        "https://api.fitbit.com/oauth2/token",
                        data=refresh_data,
                        headers={
                            "Authorization": f"Basic {b64_auth}",
                            "Content-Type": "application/x-www-form-urlencoded"
                        },
                        method='POST'
                    )
                    
                    try:
                        with urllib.request.urlopen(refresh_req) as refresh_res:
                            new_token_data = json.loads(refresh_res.read().decode())
                            
                        # Update DB
                        table_main.update_item(
                            Key={'param': f'SUBJECT#{subject_id}'},
                            UpdateExpression="SET #d.fitbit_token = :t",
                            ExpressionAttributeNames={'#d': 'data'},
                            ExpressionAttributeValues={':t': convert_floats_to_decimals(new_token_data)}
                        )
                        print(f"Token refreshed for {subject_id}")
                        # Retry original request with new token
                        return fetch_with_refresh(url, new_token_data['access_token'], retry=False)
                    except Exception as refresh_err:
                        print(f"Refresh failed: {refresh_err}")
                        raise e # Raise original 401
                raise e

        # Use JST for correct Date
        now_jst = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
        today_str = now_jst.strftime("%Y-%m-%d")
        yesterday_str = (now_jst - datetime.timedelta(days=1)).strftime("%Y-%m-%d")

        # 2. Fetch Today's Steps
        try:
            # explicit date date/{today_str}.json
            data = fetch_with_refresh(f"https://api.fitbit.com/1/user/-/activities/date/{today_str}.json", access_token)
            steps_today = data.get('summary', {}).get('steps', 0)
        except Exception as e:
            print(f"Fitbit Today Error: {e}")
            steps_today = 0
                 
        # 3. Fetch Yesterday's Steps
        steps_yesterday = 0
        try:
            data_y = fetch_with_refresh(f"https://api.fitbit.com/1/user/-/activities/date/{yesterday_str}.json", access_token)
            steps_yesterday = data_y.get('summary', {}).get('steps', 0)
        except Exception as e:
            print(f"Fitbit Yesterday Error: {e}")

        return create_response(200, {
            'steps': steps_today, 
            'steps_yesterday': steps_yesterday,
            'status': 'success'
        })
        
    except Exception as e:
        print(f"Fitbit Logic Error: {e}")
        return create_response(500, {'error': str(e)})

def handle_fitbit_callback(event):
    params = event.get('queryStringParameters') or {}
    code = params.get('code')
    state = params.get('state') # This is subjectId
    
    if not code:
        return create_response(400, {'error': 'Missing code'})
        
    subject_id = state
    
    # Token Exchange
    token_url = "https://api.fitbit.com/oauth2/token"
    client_id = FITBIT_CLIENT_ID
    client_secret = FITBIT_CLIENT_SECRET
    redirect_uri = f"{API_BASE_URL}/fitbit/callback"
    
    # Auth Header
    # Basic Authorization: "Basic " + base64encode(client_id + ":" + client_secret)
    auth_str = f"{client_id}:{client_secret}"
    b64_auth = base64.b64encode(auth_str.encode()).decode()
    
    headers = {
        "Authorization": f"Basic {b64_auth}",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    
    data = {
        "client_id": client_id,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
        "code": code
    }
    
    try:
        # Request access token
        # urlencode data for body
        post_body = urlencode(data).encode('utf-8')
        
        req = urllib.request.Request(token_url, post_body, headers, method='POST')
        
        with urllib.request.urlopen(req) as res:
            token_resp = json.loads(res.read().decode())
            
        # Store in DynamoDB (ActivityPacing_Main)
        # Update user record with fitbit_token
        
        print(f"Fitbit Token Acquired for {subject_id}")
        
        table_main.update_item(
             Key={'param': f'SUBJECT#{subject_id}'},
             UpdateExpression="SET #d.fitbit_token = :t, #d.hasFitbit = :b",
             ExpressionAttributeNames={'#d': 'data'},
             ExpressionAttributeValues={
                 ':t': convert_floats_to_decimals(token_resp), # Ensure decimal compat if any floats
                 ':b': True
             }
        )
        
        # Success Response - Simple HTML
        return_url = f"{FRONTEND_URL}/?fitbit=success"
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>連携完了 - Activity Pacing</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 20px; background: #f0fdf4; color: #166534; display: flex; flex-direction: column; justify-content: center; min-height: 90vh; margin: 0; }
                .card { background: white; padding: 40px 24px; border-radius: 32px; box-shadow: 0 20px 40px rgba(22, 101, 52, 0.08); max-width: 400px; margin: 0 auto; width: 100%; box-sizing: border-box; }
                h1 { margin: 0 0 16px 0; font-size: 26px; font-weight: 800; letter-spacing: -0.02em; }
                p { margin: 0 0 32px 0; font-size: 15px; opacity: 0.8; line-height: 1.6; }
                .icon { font-size: 64px; margin-bottom: 24px; display: block; animation: bounce 2s infinite; }
                .btn { display: block; padding: 16px 32px; background: #166534; color: white; border-radius: 16px; text-decoration: none; font-weight: bold; font-size: 16px; box-shadow: 0 8px 16px rgba(22, 101, 52, 0.2); transition: transform 0.2s; }
                .btn:active { transform: scale(0.98); }
                @keyframes bounce { 0%, 20%, 50%, 80%, 100% {transform: translateY(0);} 40% {transform: translateY(-10px);} 60% {transform: translateY(-5px);} }
            </style>
        </head>
        <body>
            <div class="card">
                <span class="icon">✨</span>
                <h1>Fitbit連携成功!</h1>
                <p>Fitbitとの接続が完了しました。<br>計測された歩数がアプリに同期されます。</p>
                <a href="__RETURN_URL__" class="btn">アプリに戻る</a>
                <p style="margin-top: 24px; font-size: 12px; opacity: 0.5;">※このタブを閉じてLINEに戻っても大丈夫です</p>
            </div>
        </body>
        </html>
        """
        html = html.replace("__RETURN_URL__", return_url)

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'text/html'
            },
            'body': html
        }

    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"Token Exchange Error: {err_body}")
        return create_response(500, {'error': f'Token exchange failed: {err_body}'})
    except Exception as e:
        print(f"Callback Error: {e}")
        return create_response(500, {'error': str(e)})


# --- Google Health API Handlers (Fitbit後継) ---

def handle_health_auth(event):
    """
    Google OAuth の認可画面へリダイレクトする。
    subjectId を state として渡し、callback で受け取る。
    """
    params = event.get('queryStringParameters') or {}
    subject_id = params.get('subjectId') or params.get('state') or 'unknown'

    if not GOOGLE_CLIENT_ID:
        return create_response(500, {'error': 'GOOGLE_CLIENT_ID is not configured'})

    redirect_uri = f"{API_BASE_URL}/health/callback"
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code"
        f"&client_id={quote(GOOGLE_CLIENT_ID, safe='')}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&scope={quote(GOOGLE_HEALTH_SCOPE)}"
        "&access_type=offline&prompt=consent"  # refresh_token を確実に得る
        f"&state={quote(str(subject_id), safe='')}"
    )

    return {
        'statusCode': 302,
        'headers': {
            'Location': auth_url,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,OPTIONS'
        },
        'body': ''
    }


def refresh_google_token(refresh_token, subject_id):
    """
    Google のアクセストークン(1時間で失効)を refresh_token で更新し、DBに保存する。
    新しい access_token を返す。失敗時は None。
    """
    token_url = "https://oauth2.googleapis.com/token"
    data = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token"
    }).encode('utf-8')
    try:
        req = urllib.request.Request(
            token_url, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method='POST'
        )
        with urllib.request.urlopen(req) as res:
            new_token = json.loads(res.read().decode())
        # Google は refresh 時に refresh_token を返さないことがある → 既存を保持
        if 'refresh_token' not in new_token:
            new_token['refresh_token'] = refresh_token
        table_main.update_item(
            Key={'param': f'SUBJECT#{subject_id}'},
            UpdateExpression="SET #d.google_health_token = :t",
            ExpressionAttributeNames={'#d': 'data'},
            ExpressionAttributeValues={':t': convert_floats_to_decimals(new_token)}
        )
        print(f"Google token refreshed for {subject_id}")
        return new_token.get('access_token')
    except Exception as e:
        print(f"Google token refresh failed: {e}")
        return None


def handle_health_callback(event):
    """
    Google からの認可コードをトークンに交換し、被験者レコードに保存する。
    """
    params = event.get('queryStringParameters') or {}
    code = params.get('code')
    subject_id = params.get('state')  # handle_health_auth で渡した subjectId

    if not code or not subject_id:
        return create_response(400, {'error': 'Missing code or state'})

    token_url = "https://oauth2.googleapis.com/token"
    redirect_uri = f"{API_BASE_URL}/health/callback"
    post_body = urlencode({
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code"
    }).encode('utf-8')

    try:
        req = urllib.request.Request(
            token_url, data=post_body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method='POST'
        )
        with urllib.request.urlopen(req) as res:
            token_resp = json.loads(res.read().decode())

        print(f"Google Health Token acquired for {subject_id}")

        table_main.update_item(
            Key={'param': f'SUBJECT#{subject_id}'},
            UpdateExpression="SET #d.google_health_token = :t, #d.hasGoogleHealth = :b",
            ExpressionAttributeNames={'#d': 'data'},
            ExpressionAttributeValues={
                ':t': convert_floats_to_decimals(token_resp),
                ':b': True
            }
        )

        return_url = f"{FRONTEND_URL}/?health=success"
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>連携完了 - Activity Pacing</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 20px; background: #f0fdf4; color: #166534; display: flex; flex-direction: column; justify-content: center; min-height: 90vh; margin: 0; }
                .card { background: white; padding: 40px 24px; border-radius: 32px; box-shadow: 0 20px 40px rgba(22, 101, 52, 0.08); max-width: 400px; margin: 0 auto; width: 100%; box-sizing: border-box; }
                h1 { margin: 0 0 16px 0; font-size: 26px; font-weight: 800; }
                p { margin: 0 0 32px 0; font-size: 15px; opacity: 0.8; line-height: 1.6; }
                .icon { font-size: 64px; margin-bottom: 24px; display: block; }
                .btn { display: block; padding: 16px 32px; background: #166534; color: white; border-radius: 16px; text-decoration: none; font-weight: bold; font-size: 16px; }
            </style>
        </head>
        <body>
            <div class="card">
                <span class="icon">✨</span>
                <h1>健康データ連携 成功!</h1>
                <p>Google Health との接続が完了しました。<br>歩数などがアプリに同期されます。</p>
                <a href="__RETURN_URL__" class="btn">アプリに戻る</a>
                <p style="margin-top: 24px; font-size: 12px; opacity: 0.5;">※このタブを閉じてLINEに戻っても大丈夫です</p>
            </div>
        </body>
        </html>
        """
        html = html.replace("__RETURN_URL__", return_url)

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'text/html'},
            'body': html
        }

    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"Google Token Exchange Error: {err_body}")
        return create_response(500, {'error': f'Token exchange failed: {err_body}'})
    except Exception as e:
        print(f"Google Callback Error: {e}")
        return create_response(500, {'error': str(e)})


def handle_health_steps(event):
    """
    Google Health API から歩数を取得する。
    注意: 新APIのレスポンス形式は実呼び出しで要確認のため、生データをログ出力し
    防御的にパースする（初回キャリブレーション後に確定させる）。
    """
    params = event.get('queryStringParameters') or {}
    subject_id = params.get('subjectId')

    if not subject_id:
        return create_response(400, {'error': 'Missing subjectId'})

    try:
        user_res = table_main.get_item(Key={'param': f'SUBJECT#{subject_id}'})
        item = user_res.get('Item')
        if not item:
            return create_response(404, {'error': 'User not found'})

        user_data = item.get('data', item)
        token_data = user_data.get('google_health_token')

        if not token_data or 'access_token' not in token_data:
            return create_response(200, {'steps': 0, 'steps_yesterday': 0, 'status': 'no_token'})

        access_token = token_data['access_token']
        refresh_token = token_data.get('refresh_token')

        # アクセストークンを更新可能な形で保持（ページング中のリフレッシュに対応）
        token_state = {'token': access_token}

        def gh_get(url, retry=True):
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {token_state['token']}", "Accept": "application/json"}
            )
            try:
                with urllib.request.urlopen(req) as res:
                    return json.loads(res.read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 401 and retry and refresh_token:
                    new_token = refresh_google_token(refresh_token, subject_id)
                    if new_token:
                        token_state['token'] = new_token
                        return gh_get(url, retry=False)
                raise e

        # 日付タプル(JST現地日付)。civilStartTime が現地日付なのでこれと比較する
        now_jst = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
        today_tuple = (now_jst.year, now_jst.month, now_jst.day)
        y_jst = now_jst - datetime.timedelta(days=1)
        yesterday_tuple = (y_jst.year, y_jst.month, y_jst.day)

        def point_count(p):
            try:
                return int(p.get('steps', {}).get('count', 0))
            except (ValueError, TypeError):
                return 0

        def point_date(p):
            d = (p.get('steps', {}).get('interval', {})
                 .get('civilStartTime', {}).get('date', {}))
            if d:
                return (d.get('year'), d.get('month'), d.get('day'))
            return None

        # Google Health API: 歩数データポイント（1ページ最大50件＋pageToken）
        url_base = "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints"
        steps_today = 0
        steps_yesterday = 0
        scanned = 0
        page_token = None

        for _ in range(40):  # 安全上限: 40ページ(最大2000件)
            url = url_base + (f"?pageToken={quote(page_token, safe='')}" if page_token else "")
            data = gh_get(url)
            points = data.get('dataPoints') or []
            scanned += len(points)

            oldest_in_page = None
            for p in points:
                cnt = point_count(p)
                pd = point_date(p)
                if pd == today_tuple:
                    steps_today += cnt
                elif pd == yesterday_tuple:
                    steps_yesterday += cnt
                if pd:
                    oldest_in_page = pd  # 各ページは新しい順なので末尾が最古

            page_token = data.get('nextPageToken')
            if not page_token:
                break
            # このページの最古が前々日まで遡ったら、今日・昨日は取り切ったので終了
            if oldest_in_page and oldest_in_page < yesterday_tuple:
                break

        return create_response(200, {
            'steps': steps_today,
            'steps_yesterday': steps_yesterday,
            'status': 'success',
            'points_scanned': scanned
        })

    except urllib.error.HTTPError as e:
        err_body = ''
        try:
            err_body = e.read().decode()
        except Exception:
            pass
        print(f"GoogleHealth steps HTTPError: {e.code} {err_body}")
        return create_response(500, {'error': f'Health API error {e.code}', 'detail': err_body[:500]})
    except Exception as e:
        print(f"GoogleHealth steps error: {e}")
        return create_response(500, {'error': str(e)})


# --- LINE Push Notification (Messaging API) ---

def push_line_message(line_user_id, text):
    """指定したLINEユーザーへプッシュメッセージを送る。"""
    if not LINE_CHANNEL_ACCESS_TOKEN:
        print("LINE_CHANNEL_ACCESS_TOKEN not set; skip push")
        return False
    if not line_user_id:
        return False
    payload = json.dumps({
        "to": line_user_id,
        "messages": [{"type": "text", "text": text[:4900]}]
    }).encode('utf-8')
    req = urllib.request.Request(
        "https://api.line.me/v2/bot/message/push",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}"
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req) as res:
            return True
    except urllib.error.HTTPError as e:
        try:
            print("LINE push failed:", e.code, e.read().decode()[:300])
        except Exception:
            print("LINE push failed:", e.code)
        return False
    except Exception as e:
        print("LINE push error:", e)
        return False


def _list_linked_subjects():
    """linkedLineUserId を持つ被験者データの一覧 [(data, lineUserId), ...] を返す。"""
    from boto3.dynamodb.conditions import Attr
    out = []
    resp = table_main.scan(FilterExpression=Attr('param').begins_with("SUBJECT#"))
    items = resp.get('Items', [])
    while 'LastEvaluatedKey' in resp:
        resp = table_main.scan(
            FilterExpression=Attr('param').begins_with("SUBJECT#"),
            ExclusiveStartKey=resp['LastEvaluatedKey']
        )
        items.extend(resp.get('Items', []))
    for it in items:
        d = it.get('data', {})
        uid = d.get('linkedLineUserId')
        if uid:
            out.append((d, uid))
    return out


def run_scheduled_reminders():
    """各ユーザーの daily_schedule を見て、開始 REMINDER_LEAD_MIN 分前の活動をLINE通知する。"""
    now_jst = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
    now_min = now_jst.hour * 60 + now_jst.minute
    today = now_jst.strftime("%Y-%m-%d")
    sent = 0

    for d, uid in _list_linked_subjects():
        schedule = d.get('daily_schedule')
        if not isinstance(schedule, list):
            continue
        # 当日分のみ残して重複送信を防ぐ
        notified = [k for k in (d.get('notified_keys') or []) if str(k).startswith(today)]
        changed = False

        for task in schedule:
            if not isinstance(task, dict):
                continue
            sm = task.get('startMinute')
            if sm is None:
                continue
            try:
                sm = int(sm)
            except (ValueError, TypeError):
                continue
            remind_at = sm - REMINDER_LEAD_MIN
            if remind_at <= now_min < remind_at + REMINDER_WINDOW_MIN:
                key = f"{today}#{sm}#{task.get('title', '')}"
                if key in notified:
                    continue
                title = task.get('title', '活動')
                msg = (f"まもなく {sm // 60:02d}:{sm % 60:02d} から"
                       f"「{title}」の時間です。\n無理せず、できる範囲で動きましょう🌱")
                if push_line_message(uid, msg):
                    notified.append(key)
                    changed = True
                    sent += 1

        if changed:
            sid = d.get('id')
            if sid is not None:
                try:
                    table_main.update_item(
                        Key={'param': f"SUBJECT#{sid}"},
                        UpdateExpression="SET #d.notified_keys = :k",
                        ExpressionAttributeNames={'#d': 'data'},
                        ExpressionAttributeValues={':k': notified}
                    )
                except Exception as e:
                    print("notified_keys save failed:", e)

    print(f"run_scheduled_reminders: sent={sent}")
    return sent


def run_daily_ai_push():
    """毎朝、AI生成の応援メッセージ(今日の提案)をLINEで送る。"""
    sent = 0
    for d, uid in _list_linked_subjects():
        try:
            cond = {"fatigue_0_10": 5, "pain_0_10": 0,
                    "energy_budget_0_100": 60, "sleep_quality": 1}
            msg = generate_message_bedrock(
                "Normal", "おはようございます。", cond, "", ["10:00", "14:00"]
            )
            if push_line_message(uid, "☀️ おはようございます！\n" + msg):
                sent += 1
        except Exception as e:
            print("daily ai push error:", e)
    print(f"run_daily_ai_push: sent={sent}")
    return sent


def login_with_line(body):
    """
    Checks if a LINE UID is linked to a Subject ID via LINE_ALIAS.
    """
    liff_user_id = body.get('userId')
    if not liff_user_id:
        return create_response(400, {'error': 'Missing userId'})
    
    print(f"LINE Login attempt for: {liff_user_id}")
    try:
        # 1. Check for Alias Record
        alias_resp = table_main.get_item(Key={'param': f'LINE_ALIAS#{liff_user_id}'})
        if 'Item' in alias_resp:
            subject_id = alias_resp['Item'].get('subjectId')
            print(f"  -> Found Alias: linked to subject {subject_id}")
            return get_subject_data(subject_id)
        
        # 2. Check for Direct Record (backward compatibility)
        return get_subject_data(liff_user_id)
    except Exception as e:
        print(f"  -> Error in login_with_line: {e}")
        return create_response(500, {'error': str(e)})

def link_line_id(subject_id, body):
    """
    Links a LINE UID to a specific Subject ID by creating a LINE_ALIAS record.
    """
    liff_user_id = body.get('userId')
    if not liff_user_id or not subject_id:
        return create_response(400, {'error': 'Missing userId or subjectId'})
    
    print(f"Linking Subject {subject_id} to LINE {liff_user_id}")
    try:
        # 1. Create Alias record
        table_main.put_item(
            Item={
                'param': f'LINE_ALIAS#{liff_user_id}',
                'subjectId': subject_id,
                'linkedAt': datetime.datetime.now().isoformat()
            }
        )
        # 2. Update Subject record with pointer
        try:
            table_main.update_item(
                Key={'param': f'SUBJECT#{subject_id}'},
                UpdateExpression="SET #d.linkedLineUserId = :uid",
                ExpressionAttributeNames={'#d': 'data'},
                ExpressionAttributeValues={':uid': liff_user_id}
            )
        except Exception as update_err:
            print(f"  -> Linked record update warning (non-fatal): {update_err}")

        return create_response(200, {
            'status': 'success', 
            'subjectId': subject_id, 
            'linkedLineUserId': liff_user_id
        })
    except Exception as e:
        print(f"  -> Error linking LINE ID: {e}")
        return create_response(500, {'error': str(e)})
